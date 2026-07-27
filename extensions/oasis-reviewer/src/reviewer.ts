import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  botKeyFor,
  constitutionalReviewRequired,
  constitutionFor,
  DEFAULT_HARD_POLICY,
  evaluateHard,
  loadPolicyFile,
  resolveHardPolicy,
  type Decision,
  type HardPolicy,
} from "./policy.js";
import { judgeConstitution, type LlmComplete } from "./layer2.js";

// Layer 2 concurrency cap — bound the number of in-flight model judgments so a
// burst of ambiguous calls can't spawn dozens of top-tier completions at once.
const L2_MAX_INFLIGHT = 3;
let l2InFlight = 0;

// ── Unified reviewer (.swarm/UNIFIED_REVIEWER.md) ──────────────────────────────
// before_tool_call hook → Layer 1 (hard, deterministic, per-bot from
// reviewer-policy.json) → Layer 2 (constitution, model-judged via
// runtime.llm.complete). L1 verdicts map to native returns: allow→void,
// deny→{block}, escalate→{requireApproval, timeoutBehavior:"deny"} (fail-closed).
// L2 is SHADOW-first (OASIS_REVIEWER_L2=off|shadow): it fires ASYNC (never blocks
// the hook) and only LOGS its verdict, so the constitution is calibrated before it
// enforces. Non-bundled plugins MUST declare hooks.allowConversationAccess
// (entrypoint) or the hook never fires.

export type ReviewerMode = "shadow" | "enforce";

export interface ReviewerOptions {
  auditDir: string;
  mode: ReviewerMode;
  policyFile?: string;
}

type ToolFamily = "exec" | "file" | "web" | "other";

function classifyTool(toolName: string, toolKind?: string, toolInputKind?: string): ToolFamily {
  const hint = `${toolKind ?? ""} ${toolInputKind ?? ""} ${toolName}`.toLowerCase();
  if (/(^|\b)(exec|shell|bash|command)\b/.test(hint)) return "exec";
  if (/(file|dir|read|write|edit|patch|fs|cat|stat|grep)\b/.test(hint)) return "file";
  if (/(web|fetch|search|http|url)\b/.test(hint)) return "web";
  return "other";
}

function subjectOf(family: ToolFamily, params: Record<string, unknown> | undefined, derivedPaths: readonly string[] | undefined): string {
  if (derivedPaths && derivedPaths.length > 0) return derivedPaths.join(" ");
  const o = params ?? {};
  const first = (...keys: string[]): string => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.length > 0) return v;
      if (Array.isArray(v)) return v.map(String).join(" ");
    }
    return "";
  };
  if (family === "exec") return first("command", "cmd", "argv", "script", "input", "code");
  if (family === "file") return first("path", "file", "filePath", "file_path", "target");
  if (family === "web") return first("url", "href", "query", "q", "target");
  return "";
}

function safeJson(value: unknown, max = 2000): string {
  try {
    const raw = JSON.stringify(value) ?? String(value);
    return raw.length > max ? raw.slice(0, max) + "…[truncated]" : raw;
  } catch {
    return "[unserializable]";
  }
}

export function registerReviewer(api: OpenClawPluginApi, opts: ReviewerOptions): void {
  const { auditDir, mode, policyFile } = opts;
  try {
    mkdirSync(auditDir, { recursive: true });
  } catch {
    /* never a hard dependency */
  }
  const auditFile = join(auditDir, "reviewer-audit.jsonl");
  const write = (row: Record<string, unknown>): void => {
    try {
      appendFileSync(auditFile, JSON.stringify(row) + "\n");
    } catch {
      /* best-effort */
    }
  };

  // Resolve this container's identity + per-bot policy once at register.
  const policy = policyFile ? loadPolicyFile(policyFile) : null;
  const agentName = process.env.OASIS_AGENT_NAME ?? "";
  const botKey = botKeyFor(agentName, policy?.botAliases);
  const hardPolicy: HardPolicy = policy ? resolveHardPolicy(policy, botKey) : DEFAULT_HARD_POLICY;
  const constitution = constitutionFor(policy, botKey);
  const alwaysConstitutional = constitutionalReviewRequired(policy, botKey);

  // Layer 2 (constitution, model-judged). SHADOW-first: OASIS_REVIEWER_L2 ∈
  // off|shadow (enforce is a later increment). Uses the plugin runtime's
  // llm.complete (top-tier model). Degrades to off if the runtime doesn't expose
  // it. Never blocks the hook — the judgment fires async and lands in the audit.
  const l2Mode = (process.env.OASIS_REVIEWER_L2 ?? "off").toLowerCase();
  const l2Model = process.env.OASIS_REVIEWER_MODEL || undefined; // default: agent's own model
  const runtime = (api as unknown as { runtime?: { llm?: { complete?: LlmComplete } } }).runtime;
  const l2Complete: LlmComplete | undefined =
    l2Mode !== "off" && typeof runtime?.llm?.complete === "function"
      ? (runtime.llm.complete.bind(runtime.llm) as LlmComplete)
      : undefined;
  if (l2Mode !== "off" && !l2Complete) {
    api.logger.info("oasis-reviewer: Layer 2 requested but runtime.llm.complete unavailable — L2 stays OFF");
  }

  api.on("before_tool_call", (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
    let decision: Decision = { verdict: "allow", principle: "hard:default-allow", reason: "" };
    let toolName = "unknown";
    let needsConstitution = false;
    try {
      toolName = String(event.toolName ?? "unknown");
      const toolKind = event.toolKind as string | undefined;
      const toolInputKind = event.toolInputKind as string | undefined;
      const params = event.params as Record<string, unknown> | undefined;
      const derivedPaths = event.derivedPaths as readonly string[] | undefined;
      const family = classifyTool(toolName, toolKind, toolInputKind);

      // ── Layer 1: hard constraints (per-bot) ──
      decision = evaluateHard({ family, toolName, params, derivedPaths }, hardPolicy);

      // ── Layer 2: constitution (model-judged) ──
      // Runs on the ambiguous middle (Layer 1 allowed) — and ALWAYS for bots
      // flagged constitutionalReviewRequired (nimbus/helloworld: judge every ask
      // for secret-malicious use of google data). Layer 2 may only TIGHTEN. It
      // fires below (async, shadow) when OASIS_REVIEWER_L2 != off.
      needsConstitution = constitution.length > 0 && (decision.verdict === "allow" || alwaysConstitutional);

      const subject = subjectOf(family, params, derivedPaths);
      const paramsJson = safeJson(params);
      const sessionId = ctx?.sessionId ?? "unknown";

      write({
        ts: new Date().toISOString(),
        phase: "before_tool_call",
        mode,
        bot: botKey,
        sessionId,
        agentId: ctx?.agentId ?? null,
        toolCallId: event.toolCallId ?? null,
        toolName,
        family,
        subject,
        derivedPaths: derivedPaths ?? null,
        params: paramsJson,
        verdict: decision.verdict,
        principle: decision.principle,
        reason: decision.reason,
        layer2Pending: needsConstitution,
        enforced: mode === "enforce" && decision.verdict !== "allow",
      });

      // ── Layer 2 (constitution, model-judged) — SHADOW: fire-and-forget ──
      // Non-blocking: the hook returns the Layer 1 verdict immediately; the model
      // judgment lands in the audit as a separate `phase:"layer2"` row. Bounded by
      // a concurrency cap so a burst can't spawn many top-tier completions. In
      // shadow this NEVER changes the enforced decision — it only records what the
      // constitution would say, so it can be calibrated before it enforces.
      // Cost gate for the shadow increment: L2 judges the genuinely-ambiguous
      // middle, not every benign read. Fire on file-WRITES + web + always for the
      // google-data bots (nimbus/helloworld). Exec is deferred — it is already
      // deterministically gated by L1 (destructive/download-exec/substitution/
      // self-runtime), so L2-on-exec is a later increment.
      const isWriteLike =
        family === "file" &&
        (/write|edit|patch|create|append|mkdir|mv|cp|rm|delete|tee/i.test(toolName) ||
          (!!params && ("content" in params || "text" in params)));
      const l2Worthwhile = alwaysConstitutional || isWriteLike || family === "web";
      if (needsConstitution && l2Worthwhile && l2Complete && l2Mode !== "off" && l2InFlight < L2_MAX_INFLIGHT) {
        l2InFlight++;
        const l1Verdict = decision.verdict;
        const l1Principle = decision.principle;
        void judgeConstitution(
          l2Complete,
          { botKey, toolName, family, subject, params: paramsJson, constitution },
          // No agentId: passing it is treated as a target-agent OVERRIDE and
          // rejected ("Plugin LLM completion cannot override the target agent").
          // Omitting it uses the ambient agent's own model/credentials.
          { model: l2Model, timeoutMs: 20_000 },
        )
          .then((r) => {
            write({
              ts: new Date().toISOString(),
              phase: "layer2",
              l2Mode,
              bot: botKey,
              sessionId,
              toolName,
              family,
              subject,
              l1Verdict,
              l1Principle,
              l2Verdict: r.decision?.verdict ?? null,
              l2Principle: r.decision?.principle ?? null,
              l2Reason: r.decision?.reason ?? null,
              l2AgreesWithL1: r.decision ? r.decision.verdict === l1Verdict : null,
              l2Ms: r.ms,
              l2ParseFail: r.decision ? undefined : (r.raw || null),
              l2Error: r.error ?? null,
              enforced: false, // shadow: L2 never changes the decision yet
            });
          })
          .finally(() => {
            l2InFlight--;
          });
      }
    } catch (err) {
      write({ ts: new Date().toISOString(), phase: "before_tool_call", mode, bot: botKey, toolName, error: String((err as Error)?.message ?? err), enforced: mode === "enforce" });
      // CLAW-073 FAIL-CLOSE: a reviewer that cannot form a verdict must not wave the
      // call through. In ENFORCE this now DENIES the erroring call (matching the
      // design's stated fail-closed posture — openclaw's hook-runner is fail-closed,
      // but our own try/catch used to swallow that into an allow). Kept mode-aware:
      // SHADOW bots still observe-only (never block), so a reviewer bug can brick
      // neither a shadow bot nor the fleet — only the single erroring call on an
      // already-enforcing bot is denied. Degrade-safe, not brick.
      if (mode === "enforce") return { block: true, blockReason: "reviewer: internal error (fail-closed)" };
      return;
    }

    if (mode !== "enforce") return; // shadow: log only

    if (decision.verdict === "deny") return { block: true, blockReason: `reviewer: ${decision.reason}` };
    if (decision.verdict === "escalate") {
      return {
        requireApproval: {
          title: "Reviewer approval required",
          description: `${decision.reason}\n(rule: ${decision.principle}, bot: ${botKey}, tool: ${toolName})`,
          severity: "warning" as const,
          // 3 min: the operator copy-pastes `/approve <id> <decision>` from the DM;
          // 90s was too tight (a late reply hit "unknown or expired approval id").
          // Unattended still fail-closes (timeoutBehavior:"deny").
          timeoutMs: 180_000,
          timeoutBehavior: "deny" as const,
          allowedDecisions: ["allow-once", "allow-always", "deny"] as const,
        },
      };
    }
    // allow — Layer 2 (constitution) would refine this once the model call lands.
    return;
  });

  api.logger.info(`oasis-reviewer: Layer 1 active (mode=${mode}, bot=${botKey})`, {
    auditFile,
    policyLoaded: !!policy,
    constitutionPrinciples: constitution.length,
    alwaysConstitutional,
    allowWriteRoots: hardPolicy.allowWriteRoots,
    layer2: l2Complete ? `${l2Mode} (model=${l2Model ?? "agent-default"})` : "off",
  });
}
