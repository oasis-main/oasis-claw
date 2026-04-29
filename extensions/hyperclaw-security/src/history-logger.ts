/**
 * History logger — writes structured JSONL of every agent session to disk.
 *
 * Inspired by panasonic chat_api session_logs.py — same dual-stream approach:
 *   - ~/.openclaw/logs/history/YYYY/MM/DD/<sessionId>.jsonl  (all events)
 *
 * Each line is a JSON event. Events:
 *   { type: "session_start", ts, sessionId, agentId }
 *   { type: "llm_input",     ts, sessionId, messages, system, model, usage? }
 *   { type: "llm_output",    ts, sessionId, content, stopReason, usage }
 *   { type: "tool_call",     ts, sessionId, toolName, toolCallId, input }
 *   { type: "tool_result",   ts, sessionId, toolName, toolCallId, output }
 *   { type: "session_end",   ts, sessionId }
 */

import fs from "node:fs";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

function nowIso(): string {
  return new Date().toISOString();
}

function datePathSegments(): { year: string; month: string; day: string } {
  const now = new Date();
  return {
    year: String(now.getFullYear()),
    month: String(now.getMonth() + 1).padStart(2, "0"),
    day: String(now.getDate()).padStart(2, "0"),
  };
}

function resolveLogPath(logDir: string, sessionId: string): string {
  const { year, month, day } = datePathSegments();
  return path.join(logDir, year, month, day, `${sessionId}.jsonl`);
}

function appendEvent(logDir: string, sessionId: string, event: Record<string, unknown>): void {
  try {
    const filePath = resolveLogPath(logDir, sessionId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(event) + "\n", { mode: 0o600 });
  } catch {
    // never throw from a logger
  }
}

export function registerHistoryLogger(
  api: OpenClawPluginApi,
  opts: { logDir: string },
): void {
  const { logDir } = opts;

  api.on("session_start", (ctx) => {
    const sessionId = (ctx.sessionId as string | undefined) ?? "unknown";
    appendEvent(logDir, sessionId, {
      type: "session_start",
      ts: nowIso(),
      sessionId,
      agentId: ctx.agentId,
      channelId: ctx.channelId,
      sessionKey: ctx.sessionKey,
    });
  });

  api.on("session_end", (ctx) => {
    const sessionId = (ctx.sessionId as string | undefined) ?? "unknown";
    appendEvent(logDir, sessionId, {
      type: "session_end",
      ts: nowIso(),
      sessionId,
    });
  });

  api.on("llm_input", (ctx) => {
    const sessionId = (ctx.sessionId as string | undefined) ?? "unknown";
    appendEvent(logDir, sessionId, {
      type: "llm_input",
      ts: nowIso(),
      sessionId,
      model: ctx.model,
      // messages can be large — log metadata only to keep files manageable
      messageCount: Array.isArray(ctx.messages) ? ctx.messages.length : undefined,
      // Include the last user message for searchability
      lastUserMessage: (() => {
        if (!Array.isArray(ctx.messages)) return undefined;
        const msgs = ctx.messages as Array<{ role?: string; content?: unknown }>;
        const last = [...msgs].reverse().find((m) => m.role === "user");
        if (!last) return undefined;
        if (typeof last.content === "string") return last.content.slice(0, 500);
        if (Array.isArray(last.content)) {
          const textBlock = (last.content as Array<{ type?: string; text?: string }>).find(
            (b) => b.type === "text",
          );
          return textBlock?.text?.slice(0, 500);
        }
        return undefined;
      })(),
    });
  });

  api.on("llm_output", (ctx) => {
    const sessionId = (ctx.sessionId as string | undefined) ?? "unknown";
    appendEvent(logDir, sessionId, {
      type: "llm_output",
      ts: nowIso(),
      sessionId,
      model: ctx.model,
      stopReason: ctx.stopReason,
      usage: ctx.usage,
      // First 500 chars of first text block for searchability
      textPreview: (() => {
        if (!Array.isArray(ctx.content)) return undefined;
        const block = (ctx.content as Array<{ type?: string; text?: string }>).find(
          (b) => b.type === "text",
        );
        return block?.text?.slice(0, 500);
      })(),
      toolCallCount: Array.isArray(ctx.content)
        ? (ctx.content as Array<{ type?: string }>).filter((b) => b.type === "tool_use").length
        : 0,
    });
  });

  api.on("before_tool_call", (ctx) => {
    const sessionId = (ctx.sessionId as string | undefined) ?? "unknown";
    appendEvent(logDir, sessionId, {
      type: "tool_call",
      ts: nowIso(),
      sessionId,
      toolName: ctx.toolName,
      toolCallId: ctx.toolCallId,
      // Log input but truncate large values
      input: (() => {
        try {
          const raw = JSON.stringify(ctx.input);
          return raw.length > 2000 ? raw.slice(0, 2000) + "…[truncated]" : ctx.input;
        } catch {
          return "[unserializable]";
        }
      })(),
    });
  });

  api.on("after_tool_call", (ctx) => {
    const sessionId = (ctx.sessionId as string | undefined) ?? "unknown";
    appendEvent(logDir, sessionId, {
      type: "tool_result",
      ts: nowIso(),
      sessionId,
      toolName: ctx.toolName,
      toolCallId: ctx.toolCallId,
      isError: ctx.isError,
      // Truncate large outputs (browser snapshots, etc.)
      outputPreview: (() => {
        try {
          const raw = JSON.stringify(ctx.output);
          return raw.length > 2000 ? raw.slice(0, 2000) + "…[truncated]" : ctx.output;
        } catch {
          return "[unserializable]";
        }
      })(),
    });
  });
}
