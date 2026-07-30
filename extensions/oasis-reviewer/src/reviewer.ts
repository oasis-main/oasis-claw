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
  NEVER_DOWNGRADE,
  resolveHardPolicy,
  type Decision,
  type HardPolicy,
  type Verdict,
} from "./policy.js";
import { judgeConstitution, type Layer2Decision, type LlmComplete } from "./layer2.js";

// Layer 2 concurrency cap — bound the number of in-flight model judgments so a
// burst of ambiguous calls can't spawn dozens of top-tier completions at once.
const L2_MAX_INFLIGHT = 3;
let l2InFlight = 0;

// ── Unattended runs (CLAW-078) ────────────────────────────────────────────────
// An escalate needs a human. In a cron- or webhook-triggered turn there is none,
// so `requireApproval` just burns its timeout and fail-closes to deny — which is
// how the 2026-07-29 Nimbus regression presented (working cron jobs "rejected").
// openclaw tags those turns via the hook context's sessionKey:
//   cron:<jobId>   gateway/server-cron.ts:226, cron/isolated-agent/run.ts:496
//   hook:<uuid>    gateway/hooks.ts:345 (inbound webhook-triggered session)
// Consent moves to AUTHORING time (hard:cron-mutation gates add/update/remove),
// so at run time an ordinary escalate downgrades to allow. NEVER_DOWNGRADE
// escalations still fail closed. Overridable per bot without a rebuild.
// Markers are matched as SEGMENTS (see isUnattended) because the live key is
// agent-namespaced: `agent:main:cron:<jobId>`.
// KNOWN GAP: a cron job with an explicit sessionTarget gets that session's key
// instead of a cron: segment (cron/session-target.ts:18) — verified live: jobs with
// sessionTarget "main" deliver into the main session, where an approval CAN reach
// Mike, so treating those as attended is correct. Heartbeat turns still have no
// distinct segment. Every audit row records sessionKey, so any further trigger
// shapes can be read off live data instead of guessed at.
const UNATTENDED_PREFIXES = (process.env.OASIS_REVIEWER_UNATTENDED_PREFIXES ?? "cron:,hook:")
  .split(",")
  .map((p) => p.trim())
  .filter((p) => p.length > 0);

// Match the marker as a SEGMENT, not just a leading prefix. The keys openclaw
// BUILDS are bare (`cron:<jobId>` at gateway/server-cron.ts:226), but by the time
// one reaches the hook context it has been namespaced per agent — observed live
// 2026-07-30: `agent:main:cron:78991974-1e56-…`. A startsWith("cron:") test
// therefore returned FALSE on every real cron call and the downgrade never fired.
// The bug was invisible because the same deploy also fixed the false-positive that
// was causing the escalations, so the jobs passed without needing the downgrade.
function isUnattended(sessionKey: string): boolean {
  return UNATTENDED_PREFIXES.some((p) => sessionKey.startsWith(p) || sessionKey.includes(`:${p}`));
}

// Layer 2 may only ever TIGHTEN Layer 1 — the constitution is a second lock, not a
// key. A model that has just read attacker-controllable bytes must never be able to
// talk the deterministic layer down, so the combined verdict is the stricter of the
// two and a looser L2 opinion is discarded (recorded in the audit either way).
const STRICTNESS: Record<Verdict, number> = { allow: 0, escalate: 1, deny: 2 };

function tightenOnly(l1: Decision, l2: Layer2Decision): Decision {
  if (STRICTNESS[l2.verdict] <= STRICTNESS[l1.verdict]) return l1;
  return {
    verdict: l2.verdict,
    principle: `l2:${l2.principle || "constitution"}`,
    reason: l2.reason || `constitution tightened ${l1.verdict} → ${l2.verdict}`,
  };
}

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
  // off | shadow | enforce. Uses the plugin runtime's llm.complete; degrades to off
  // if the runtime doesn't expose it. SHADOW is async/log-only. ENFORCE awaits the
  // judgment and lets it TIGHTEN the L1 verdict — that costs real latency per judged
  // call, which is the price of a verdict that can actually stop the call.
  const l2Mode = (process.env.OASIS_REVIEWER_L2 ?? "off").toLowerCase();
  const l2Model = process.env.OASIS_REVIEWER_MODEL || undefined; // default: agent's own model
  const l2All = process.env.OASIS_REVIEWER_L2_ALL === "1";
  // Enforce blocks the tool call on this call, so the default is tighter than the
  // shadow-era 20s: a judge that has not answered in 12s is treated as unavailable
  // (fail-closed for constitutionalReviewRequired bots, L1-fallback otherwise).
  const l2TimeoutMs = Number(process.env.OASIS_REVIEWER_L2_TIMEOUT_MS ?? "12000") || 12_000;
  const runtime = (api as unknown as { runtime?: { llm?: { complete?: LlmComplete } } }).runtime;
  const l2Complete: LlmComplete | undefined =
    l2Mode !== "off" && typeof runtime?.llm?.complete === "function"
      ? (runtime.llm.complete.bind(runtime.llm) as LlmComplete)
      : undefined;
  if (l2Mode !== "off" && !l2Complete) {
    api.logger.info("oasis-reviewer: Layer 2 requested but runtime.llm.complete unavailable — L2 stays OFF");
  }

  api.on("before_tool_call", async (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
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
      // for secret-malicious use of google data). Layer 2 may only TIGHTEN.
      needsConstitution = constitution.length > 0 && (decision.verdict === "allow" || alwaysConstitutional);

      const subject = subjectOf(family, params, derivedPaths);
      const paramsJson = safeJson(params);
      const sessionId = ctx?.sessionId ?? "unknown";
      const sessionKey = String(ctx?.sessionKey ?? "");
      const unattended = isUnattended(sessionKey);

      // ── Which calls are worth a model judgment ──
      // constitutionalReviewRequired bots (nimbus/helloworld) → EVERY call: their
      // whole point is judging intent around Mike's Google data, and a read is
      // exactly how exfil starts. Everyone else → the acting families (exec, file
      // writes, web). Pure reads on those bots stay unjudged: L1 already denies
      // secret reads, and a model call per `ls` is latency and spend for little
      // signal. Set OASIS_REVIEWER_L2_ALL=1 to judge every call on every bot.
      const isWriteLike =
        family === "file" &&
        (/write|edit|patch|create|append|mkdir|mv|cp|rm|delete|tee/i.test(toolName) ||
          (!!params && ("content" in params || "text" in params)));
      const l2Worthwhile = l2All || alwaysConstitutional || family === "exec" || isWriteLike || family === "web";
      const l2Eligible = needsConstitution && l2Worthwhile && !!l2Complete && l2Mode !== "off";

      let l2Row: Record<string, unknown> | null = null;

      // ── Layer 2 ENFORCE: await the judgment and let it tighten ──
      // Blocking on purpose. A verdict that lands after the tool ran is an audit
      // note, not a control, so enforcement has to pay the latency (~2s measured).
      // The concurrency cap deliberately does NOT apply here: skipping a judgment
      // under load would silently drop governance instead of applying it. Parallel
      // fan-out is bounded anyway — an agent issues its tool calls one at a time,
      // so concurrency tracks the number of simultaneously-active turns.
      if (l2Eligible && l2Mode === "enforce") {
        const l1 = decision;
        const r = await judgeConstitution(
          l2Complete as LlmComplete,
          { botKey, toolName, family, subject, params: paramsJson, constitution },
          { model: l2Model, timeoutMs: l2TimeoutMs },
        );
        const combined = r.decision ? tightenOnly(l1, r.decision) : null;
        if (combined) {
          decision = combined;
        } else if (alwaysConstitutional) {
          // No verdict (timeout / unreachable model / unparseable JSON) on a bot
          // whose constitution is MANDATORY. Falling back to L1 here would recreate
          // exactly the "constitutionalReviewRequired has no teeth" gap, so this
          // fails CLOSED instead.
          decision = {
            verdict: "deny",
            principle: "l2:unavailable-fail-closed",
            reason: `constitution could not be evaluated (${r.error ?? "unparseable verdict"}) and is mandatory for ${botKey}`,
          };
        }
        // Other bots: keep the L1 verdict (L1 is still a real gate) — recorded below.
        l2Row = {
          l2Verdict: r.decision?.verdict ?? null,
          l2Principle: r.decision?.principle ?? null,
          l2Reason: r.decision?.reason ?? null,
          l2AgreesWithL1: r.decision ? r.decision.verdict === l1.verdict : null,
          l2Ms: r.ms,
          l2ParseFail: r.decision ? undefined : (r.raw || null),
          l2Error: r.error ?? null,
          l2Tightened: !!combined && combined.verdict !== l1.verdict,
          l2FailClosed: !r.decision && alwaysConstitutional,
        };
      }

      // ── Unattended adjustment (CLAW-078) ──
      // Applied to the COMBINED L1+L2 verdict, so an escalate the constitution
      // raised is handled the same way as one L1 raised. Denies are untouched: an
      // unattended run gets no free pass on destructive/exfil/control-plane. Only
      // escalations move, because unattended they are unanswerable.
      let downgraded = false;
      if (unattended && decision.verdict === "escalate") {
        if (NEVER_DOWNGRADE.has(decision.principle)) {
          decision = {
            verdict: "deny",
            principle: decision.principle,
            reason: `${decision.reason} — no approver in an unattended run (${sessionKey}); failing closed`,
          };
        } else {
          downgraded = true;
          decision = {
            verdict: "allow",
            principle: `${decision.principle}+unattended-downgrade`,
            reason: `${decision.reason} — allowed unattended (${sessionKey}); consent was given when the job was authored`,
          };
        }
      }

      write({
        ...(l2Row ?? {}),
        ts: new Date().toISOString(),
        phase: "before_tool_call",
        mode,
        bot: botKey,
        sessionId,
        // sessionKey is the trigger fingerprint (cron:<jobId>, hook:<uuid>, or a
        // channel session key). Recorded on EVERY row so the unattended-prefix list
        // stays evidence-based — this is how we find the heartbeat/sessionTarget
        // keys that prefix-matching misses today.
        sessionKey: sessionKey || null,
        unattended,
        downgraded,
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
        l2Mode,
        l2Judged: l2Eligible,
        layer2Pending: l2Eligible && l2Mode === "shadow",
        enforced: mode === "enforce" && decision.verdict !== "allow",
      });

      // ── Layer 2 SHADOW: fire-and-forget ──
      // Non-blocking: the hook returns the Layer 1 verdict immediately and the model
      // judgment lands later as a separate `phase:"layer2"` row, recording what the
      // constitution WOULD have said. Concurrency-capped, because in shadow a
      // dropped judgment costs only a log line.
      if (l2Eligible && l2Mode === "shadow" && l2InFlight < L2_MAX_INFLIGHT) {
        l2InFlight++;
        const l1Verdict = decision.verdict;
        const l1Principle = decision.principle;
        void judgeConstitution(
          l2Complete as LlmComplete,
          { botKey, toolName, family, subject, params: paramsJson, constitution },
          // No agentId: passing it is treated as a target-agent OVERRIDE and
          // rejected ("Plugin LLM completion cannot override the target agent").
          // Omitting it uses the ambient agent's own model/credentials.
          { model: l2Model, timeoutMs: l2TimeoutMs },
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
    layer2: l2Complete
      ? `${l2Mode} (model=${l2Model ?? "agent-default"}, timeout=${l2TimeoutMs}ms, scope=${l2All ? "all-calls" : alwaysConstitutional ? "all-calls(constitutional-bot)" : "exec+write+web"})`
      : "off",
  });
}
