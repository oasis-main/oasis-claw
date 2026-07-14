/**
 * Filesystem-level helpers over ~/.openclaw/agents/<agent>/sessions/.
 *
 * Idle detection and the wakeup-handoff tail are read straight from the
 * transcript files rather than via RPC: mtime is the most honest "is the bot
 * doing something" signal (any in-flight turn appends), and the tail capture
 * costs zero tokens.
 */

import fs from "node:fs";
import path from "node:path";

export function sessionsDir(homeDir: string, agentId = "main"): string {
  return path.join(homeDir, ".openclaw", "agents", agentId, "sessions");
}

/** Newest transcript mtime (ms) across live session files, or 0 when none. */
export function newestTranscriptMtimeMs(dir: string): number {
  let newest = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    // Live transcripts only — archives (.deleted., .bak-), checkpoints and
    // trajectory exports don't count as "the bot is busy".
    if (!entry.endsWith(".jsonl")) continue;
    if (/\.(deleted|bak|checkpoint|trajectory)\.?/.test(entry)) continue;
    try {
      const stat = fs.statSync(path.join(dir, entry));
      if (stat.mtimeMs > newest) {
        newest = stat.mtimeMs;
      }
    } catch {
      // raced with a rename — ignore
    }
  }
  return newest;
}

/** Busy = any live transcript changed within the grace window. */
export function isBusy(dir: string, nowMs: number, graceMinutes: number): boolean {
  const newest = newestTranscriptMtimeMs(dir);
  return newest > 0 && nowMs - newest < graceMinutes * 60_000;
}

/**
 * Extract a plain-text tail of the last few user/assistant messages from a
 * transcript — the mechanical wakeup handoff. Zero LLM involvement.
 */
export function extractTail(
  transcriptPath: string,
  opts?: { maxTurns?: number; maxChars?: number },
): string {
  const maxTurns = opts?.maxTurns ?? 12;
  const maxChars = opts?.maxChars ?? 1_600;
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return "";
  }
  const turns: string[] = [];
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0 && turns.length < maxTurns; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: unknown };
      };
      if (rec.type !== "message" || !rec.message?.role) continue;
      const role = rec.message.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = flattenContent(rec.message.content);
      if (text) {
        turns.push(`${role}: ${text.slice(0, 400)}`);
      }
    } catch {
      // non-JSON line — skip
    }
  }
  return turns.reverse().join("\n").slice(-maxChars);
}

export function flattenContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as { text: unknown }).text)
          : "",
      )
      .join(" ")
      .trim();
  }
  return "";
}

/** Locate the post-reset archive of a session file (reset renames in place). */
export function findArchiveFor(dir: string, sessionFileBase: string): string | undefined {
  try {
    const match = fs
      .readdirSync(dir)
      .filter((e) => e.startsWith(sessionFileBase) && /\.(deleted|bak)/.test(e))
      .sort()
      .pop();
    return match ? path.join(dir, match) : undefined;
  } catch {
    return undefined;
  }
}
