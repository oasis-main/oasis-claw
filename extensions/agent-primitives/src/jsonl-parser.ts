/**
 * JSONL session transcript parser for the `dream` tool.
 *
 * Understands the event format written by session-history:
 *   { type: "session_start",  ts, sessionId, agentId }
 *   { type: "llm_input",      ts, sessionId, messages, model }
 *   { type: "llm_output",     ts, sessionId, content, stopReason, usage }
 *   { type: "tool_call",      ts, sessionId, toolName, input }
 *   { type: "tool_result",    ts, sessionId, toolName, output }
 *   { type: "session_end",    ts, sessionId }
 *
 * The `distill()` function extracts a human-readable narrative of the session
 * (what the agent said/did) without needing an LLM call. LLM-driven
 * summarization is a future enhancement tracked under ORG-050.
 */

import fs from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionEvent = {
  type: string;
  ts?: string;
  sessionId?: string;
  [key: string]: unknown;
};

export type SessionDistillation = {
  sessionId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  modelCalls: number;
  toolCalls: Array<{ name: string; ts: string | null }>;
  /** Key assistant text excerpts (first 300 chars each). */
  assistantExcerpts: string[];
  /** Total input+output tokens used (if available). */
  tokensUsed: number;
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Parse a JSONL file into a list of session events. Silently skips malformed lines. */
export function parseSessionFile(filePath: string): SessionEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line) as SessionEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is SessionEvent => e !== null);
}

/** Distill a sequence of session events into a compact summary record. */
export function distillEvents(events: SessionEvent[]): SessionDistillation {
  let sessionId: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let modelCalls = 0;
  let tokensUsed = 0;
  const toolCalls: Array<{ name: string; ts: string | null }> = [];
  const assistantExcerpts: string[] = [];

  for (const event of events) {
    if (typeof event.sessionId === "string" && !sessionId) {
      sessionId = event.sessionId;
    }

    switch (event.type) {
      case "session_start":
        startedAt = (event.ts as string | null) ?? null;
        break;

      case "session_end":
        endedAt = (event.ts as string | null) ?? null;
        break;

      case "llm_output": {
        modelCalls++;
        // Extract assistant text from content (array of blocks or plain string)
        const text = extractTextFromContent(event.content);
        if (text) {
          assistantExcerpts.push(text.slice(0, 300));
        }
        // Accumulate token usage
        const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        if (usage) {
          tokensUsed += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
        }
        break;
      }

      case "tool_call": {
        const name = typeof event.toolName === "string" ? event.toolName : "unknown";
        toolCalls.push({ name, ts: (event.ts as string | null) ?? null });
        break;
      }
    }
  }

  return { sessionId, startedAt, endedAt, modelCalls, toolCalls, assistantExcerpts, tokensUsed };
}

/** Render a distillation as Markdown for insertion into memory.md. */
export function renderDistillationAsMarkdown(d: SessionDistillation): string {
  const lines: string[] = [];

  const header = [
    d.startedAt ? `**Started**: ${d.startedAt}` : null,
    d.endedAt ? `**Ended**: ${d.endedAt}` : null,
    `**Model calls**: ${d.modelCalls}`,
    d.tokensUsed ? `**Tokens**: ${d.tokensUsed.toLocaleString()}` : null,
  ].filter(Boolean);

  lines.push(...header);

  if (d.toolCalls.length > 0) {
    const toolSummary = d.toolCalls
      .reduce(
        (acc, t) => {
          acc[t.name] = (acc[t.name] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );
    const toolList = Object.entries(toolSummary)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `\`${name}\` ×${count}`)
      .join(", ");
    lines.push(`**Tools called**: ${toolList}`);
  }

  if (d.assistantExcerpts.length > 0) {
    lines.push("", "**Key assistant outputs:**");
    // Include up to 3 excerpts
    d.assistantExcerpts.slice(0, 3).forEach((excerpt, i) => {
      lines.push(`${i + 1}. ${excerpt.replace(/\n/g, " ").trim()}`);
    });
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain text from `content` which may be:
 *   - a plain string
 *   - an array of Anthropic content blocks [{ type: "text", text: "..." }, ...]
 */
function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text: string } =>
        typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
      )
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}
