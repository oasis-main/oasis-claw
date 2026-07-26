import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { DEFAULT_HARD_POLICY, evaluateHard, type Decision } from "./policy.js";

// ── Unified reviewer (.swarm/UNIFIED_REVIEWER.md) ──────────────────────────────
// Registers before_tool_call, evaluates each exec/file/web call against Layer 1
// (hard gitignore constraints). Layer 2 (constitution) slots in later at the
// marked seam. Verdicts map to native return values:
//   allow    -> return void
//   deny     -> { block: true, blockReason }
//   escalate -> { requireApproval: { …, timeoutBehavior: "deny" } }  (fail-closed)
//
// before_tool_call contract (verified v2026.7.1):
//   handler(event, ctx); event.toolName / event.params / event.derivedPaths;
//   event.toolKind / event.toolInputKind (host-authoritative). Hook is
//   fail-closed (a throw blocks). Non-bundled plugins MUST declare
//   hooks.allowConversationAccess or the hook never fires (set in entrypoint).

export type ReviewerMode = "shadow" | "enforce";

export interface ReviewerOptions {
  auditDir: string;
  mode: ReviewerMode;
}

type ToolFamily = "exec" | "file" | "web" | "other";

function classifyTool(toolName: string, toolKind?: string, toolInputKind?: string): ToolFamily {
  const hint = `${toolKind ?? ""} ${toolInputKind ?? ""} ${toolName}`.toLowerCase();
  if (/(^|\b)(exec|shell|bash|command)\b/.test(hint)) return "exec";
  if (/(file|dir|read|write|edit|patch|fs|cat|stat|grep)\b/.test(hint)) return "file";
  if (/(web|fetch|search|http|url)\b/.test(hint)) return "web";
  return "other";
}

function subjectOf(
  family: ToolFamily,
  params: Record<string, unknown> | undefined,
  derivedPaths: readonly string[] | undefined,
): string {
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
  const { auditDir, mode } = opts;
  try {
    mkdirSync(auditDir, { recursive: true });
  } catch {
    /* never make the hook a hard dependency */
  }
  const auditFile = join(auditDir, "reviewer-audit.jsonl");
  const write = (row: Record<string, unknown>): void => {
    try {
      appendFileSync(auditFile, JSON.stringify(row) + "\n");
    } catch {
      /* best-effort */
    }
  };

  api.on("before_tool_call", (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
    let decision: Decision = { verdict: "allow", principle: "hard:default-allow", reason: "" };
    let toolName = "unknown";
    try {
      toolName = String(event.toolName ?? "unknown");
      const toolKind = event.toolKind as string | undefined;
      const toolInputKind = event.toolInputKind as string | undefined;
      const params = event.params as Record<string, unknown> | undefined;
      const derivedPaths = event.derivedPaths as readonly string[] | undefined;
      const family = classifyTool(toolName, toolKind, toolInputKind);

      // ── Layer 1: hard constraints ──
      decision = evaluateHard({ family, toolName, params, derivedPaths }, DEFAULT_HARD_POLICY);

      // ── Layer 2 seam (constitution) ── only for the ambiguous middle, i.e.
      // when Layer 1 allowed. Layer 2 may only TIGHTEN (allow → escalate/deny).
      // TODO(CLAW-074 §6b): invoke the constitution model here. Not yet wired.

      write({
        ts: new Date().toISOString(),
        phase: "before_tool_call",
        mode,
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
        enforced: mode === "enforce" && decision.verdict !== "allow",
      });
    } catch (err) {
      // Hook is fail-closed; but a reviewer BUG should not brick the fleet. Log
      // and allow — a crash in our classifier must not deny legitimate work.
      write({ ts: new Date().toISOString(), phase: "before_tool_call", mode, toolName, error: String((err as Error)?.message ?? err) });
      return; // allow on internal error
    }

    // SHADOW: log the would-verdict, never act.
    if (mode !== "enforce") return;

    // ENFORCE: map verdict → native before_tool_call result.
    if (decision.verdict === "deny") {
      return { block: true, blockReason: `reviewer: ${decision.reason}` };
    }
    if (decision.verdict === "escalate") {
      return {
        requireApproval: {
          title: "Reviewer approval required",
          description: `${decision.reason}\n(rule: ${decision.principle}, tool: ${toolName})`,
          severity: "warning" as const,
          timeoutMs: 90_000,
          timeoutBehavior: "deny" as const, // fail-closed: unresolved → deny
          allowedDecisions: ["allow-once", "allow-always", "deny"] as const,
        },
      };
    }
    return; // allow
  });

  api.logger.info(`oasis-reviewer: Layer 1 active (mode=${mode})`, { auditFile });
}
