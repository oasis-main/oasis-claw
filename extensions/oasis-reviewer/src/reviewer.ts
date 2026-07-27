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

// ── Unified reviewer (.swarm/UNIFIED_REVIEWER.md) ──────────────────────────────
// before_tool_call hook → Layer 1 (hard, deterministic, per-bot from
// reviewer-policy.json) → Layer 2 seam (constitution, model-judged — staged).
// Verdicts map to native returns: allow→void, deny→{block}, escalate→
// {requireApproval, timeoutBehavior:"deny"} (fail-closed). Non-bundled plugins
// MUST declare hooks.allowConversationAccess (entrypoint) or the hook never fires.

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

      // ── Layer 2 seam: constitution (model-judged) ──
      // Runs on the ambiguous middle (Layer 1 allowed) — and ALWAYS for bots
      // flagged constitutionalReviewRequired (nimbus/helloworld: judge every ask
      // for secret-malicious use of google data). Layer 2 may only TIGHTEN.
      // Model call is staged (pairs with the approval route, CLAW-073); for now
      // we RECORD that Layer 2 would run, so the shadow calibration period has data.
      needsConstitution = constitution.length > 0 && (decision.verdict === "allow" || alwaysConstitutional);

      write({
        ts: new Date().toISOString(),
        phase: "before_tool_call",
        mode,
        bot: botKey,
        sessionId: ctx?.sessionId ?? "unknown",
        agentId: ctx?.agentId ?? null,
        toolCallId: event.toolCallId ?? null,
        toolName,
        family,
        subject: subjectOf(family, params, derivedPaths),
        derivedPaths: derivedPaths ?? null,
        params: safeJson(params),
        verdict: decision.verdict,
        principle: decision.principle,
        reason: decision.reason,
        layer2Pending: needsConstitution,
        enforced: mode === "enforce" && decision.verdict !== "allow",
      });
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
          timeoutMs: 90_000,
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
  });
}
