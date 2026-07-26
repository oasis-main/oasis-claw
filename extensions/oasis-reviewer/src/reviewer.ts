import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ── Skeleton phase (§10.1 of .swarm/UNIFIED_REVIEWER.md) ───────────────────────
// Register the before_tool_call hook, classify each call, and write an audit row.
// SHADOW ONLY: never blocks. Captures the REAL param shapes for exec/file/web on
// live yesman traffic so Layer 1 (hard gitignore constraints) and Layer 2
// (constitution) can parse them precisely.
//
// before_tool_call contract (verified v2026.7.1, src/plugins/hook-types.ts):
//   handler(event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext)
//     event.toolName            string
//     event.params              Record<string,unknown>  ← the tool input
//     event.derivedPaths?       readonly string[]       ← host-derived file paths
//     event.toolKind?/toolInputKind?  host-authoritative discriminators
//     ctx.sessionId/agentId/channelId/...
//   return PluginHookBeforeToolCallResult | void:
//     allow    -> return            (void)
//     deny     -> { block: true, blockReason }
//     escalate -> { requireApproval: { title, description, severity,
//                    timeoutBehavior: "deny", allowedDecisions, onResolution } }
//     (may also rewrite params). Hook is FAIL-CLOSED (a throw blocks the call).

export type ReviewerMode = "shadow" | "enforce";

export interface ReviewerOptions {
  auditDir: string;
  mode: ReviewerMode;
}

type ToolFamily = "exec" | "file" | "web" | "other";

// Prefer the host-authoritative toolKind/toolInputKind; fall back to the name.
function classifyTool(toolName: string, toolKind?: string, toolInputKind?: string): ToolFamily {
  const hint = `${toolKind ?? ""} ${toolInputKind ?? ""} ${toolName}`.toLowerCase();
  if (/(^|\b)(exec|shell|bash|command)\b/.test(hint)) return "exec";
  if (/(file|dir|read|write|edit|patch|fs)\b/.test(hint)) return "file";
  if (/(web|fetch|search|http|url)\b/.test(hint)) return "web";
  return "other";
}

// Best-effort "subject" — the thing a policy judges — from event.params +
// host-derived paths. Falls back to the raw params JSON so nothing is hidden.
function describeSubject(
  family: ToolFamily,
  params: Record<string, unknown> | undefined,
  derivedPaths: readonly string[] | undefined,
): string {
  if (derivedPaths && derivedPaths.length > 0) return derivedPaths.join(" ");
  const o = params ?? {};
  const first = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.length > 0) return v;
      if (Array.isArray(v)) return v.map((x) => String(x)).join(" ");
    }
    return undefined;
  };
  if (family === "exec") return first("command", "cmd", "argv", "script", "input", "code") ?? "";
  if (family === "file") return first("path", "file", "filePath", "file_path", "target") ?? "";
  if (family === "web") return first("url", "href", "query", "q", "target") ?? "";
  return "";
}

function safeJson(value: unknown, max = 4000): string {
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
    // never make the hook a hard dependency that could wedge tool execution.
  }
  const auditFile = join(auditDir, "reviewer-audit.jsonl");
  const write = (row: Record<string, unknown>): void => {
    try {
      appendFileSync(auditFile, JSON.stringify(row) + "\n");
    } catch {
      // best-effort in the skeleton; never throw from the hook.
    }
  };

  // NOTE: two args — event first, ctx second. event carries toolName/params.
  api.on(
    "before_tool_call",
    (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
      try {
        const toolName = String(event.toolName ?? "unknown");
        const toolKind = event.toolKind as string | undefined;
        const toolInputKind = event.toolInputKind as string | undefined;
        const params = (event.params ?? undefined) as Record<string, unknown> | undefined;
        const derivedPaths = event.derivedPaths as readonly string[] | undefined;
        const family = classifyTool(toolName, toolKind, toolInputKind);
        write({
          ts: new Date().toISOString(),
          phase: "before_tool_call",
          mode,
          sessionId: ctx?.sessionId ?? "unknown",
          agentId: ctx?.agentId ?? null,
          toolCallId: event.toolCallId ?? ctx?.toolCallId ?? null,
          toolName,
          toolKind: toolKind ?? null,
          toolInputKind: toolInputKind ?? null,
          family,
          subject: describeSubject(family, params, derivedPaths),
          derivedPaths: derivedPaths ?? null,
          params: safeJson(params),
          // SHADOW: no policy yet → always "allow". Layer 1/2 replace this with
          // the real hard-constraint + constitution verdict.
          verdict: "allow",
        });
      } catch (err) {
        write({
          ts: new Date().toISOString(),
          phase: "before_tool_call",
          mode,
          error: String((err as Error)?.message ?? err),
        });
      }
      // allow-all: return void (no block, no requireApproval).
    },
  );

  api.logger.info("oasis-reviewer: before_tool_call hook registered (shadow)", {
    auditFile,
    mode,
  });
}
