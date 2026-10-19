import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Full-session-trajectory reader ("Sound | Full Trajectory", 2026-08-24) ───
// Mike: the reviewer needs to see the ENTIRE session to analyze it, not just
// the last message — this exact class of bug (a short confirmation with no
// visible antecedent to the judge) has bitten the fleet more than once
// across sessions, and a single last-message capture only closes the
// one-message-back case. This reads openclaw's OWN on-disk session
// transcript (JSONL, one JSON object per line, `type:"message"` entries
// carry the actual turns) and renders a compact, judge-readable summary of
// the whole thing.
//
// Deliberately strips two things that inflate size without helping the
// judge: assistant "thinking" blocks (the model's own internal deliberation,
// including a large opaque `thinkingSignature` — not useful for judging
// consent, and can dwarf everything else in a turn) and tool-call
// usage/cost telemetry. Kept: assistant text and tool-call name+args, and
// tool results — INCLUDING past reviewer verdicts recorded there (a
// `blockReason`/escalation text lands in the transcript as a toolResult),
// which is genuinely useful signal: "this exact command was already denied
// once this session" is exactly the kind of thing a human skimming the chat
// would notice and the judge currently cannot.
//
// Capped to a caller-supplied character budget (Mike explicitly flagged the
// cost of feeding a long session to a model on every judged call) — kept
// from the NEWEST end when it doesn't fit, because the judge cares about
// what led up to THIS call, not a session's opening turns from hours ago.
// Never throws: a missing or unparsable file degrades to an empty summary
// so the caller can fall back to a shallower context tier instead of losing
// the judged call entirely.

export interface TranscriptSummary {
  text: string;
  turnCount: number;
  truncated: boolean;
}

const PER_MESSAGE_CHAR_CAP = 600;

// ── Base64 elision (2026-10-19) ──────────────────────────────────────────────
// On 2026-10-17 Nimbus's judge got empty replies on 2 reach_send calls (4
// denies with retries). A replay showed Bedrock stopReason content_filtered
// with 0 output tokens. A bisect found the trigger: ONE tool result in the
// transcript tail, a raw email body in base64 from `gog gmail get`. With only
// that line removed, both prompts got a normal verdict.
//
// Base64 carries no signal the judge can read, so each long run becomes a
// marker that keeps the fact and the size: "[base64, 1234 chars elided]". It
// runs BEFORE the per-message cap, so the cap (and the maxChars budget) holds
// real text, and the marker counts the full run.
//
// A run is a sequence of base64/base64url pieces of MIN_PIECE+ characters,
// optionally split by whitespace (MIME bodies wrap at 76 columns), with
// MIN_RUN+ base64 characters in total. The run needs a digit, an upper- and
// a lower-case letter, so a long "=====" rule or a lower-case hex digest is
// kept. URLs, paths with dots, and JSON values break on ":", ".", quotes and
// spaces, and English words are far shorter than MIN_PIECE.
//
// Only the TRANSCRIPT is elided. The params of the call under judgment go to
// the judge as they are.
const BASE64_MIN_PIECE = 60;
const BASE64_MIN_RUN = 200;
const BASE64_RUN = new RegExp(
  `[A-Za-z0-9+/_-]{${BASE64_MIN_PIECE},}={0,2}(?:\\s+[A-Za-z0-9+/_-]{${BASE64_MIN_PIECE},}={0,2})*`,
  "g",
);

// Only the head of each part is scanned: the per-message cap keeps 600
// characters, and an unbounded scan of a multi-megabyte tool result would
// cost about 1 s per 12 MB on every judged call. A run that crosses this
// limit is counted up to the limit.
const ELIDE_SCAN_CAP = 65_536;

export function elideBase64(text: string): string {
  return text.slice(0, ELIDE_SCAN_CAP).replace(BASE64_RUN, (run) => {
    const chars = run.replace(/\s+/g, "");
    if (chars.length < BASE64_MIN_RUN) return run;
    if (!/[0-9]/.test(chars) || !/[A-Z]/.test(chars) || !/[a-z]/.test(chars)) return run;
    return `[base64, ${chars.length} chars elided]`;
  });
}

function summarizeContent(content: unknown): string {
  if (typeof content === "string") return elideBase64(content).slice(0, PER_MESSAGE_CHAR_CAP);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(elideBase64(b.text));
    } else if (b.type === "toolCall" && typeof b.name === "string") {
      let args = "";
      try {
        args = elideBase64(JSON.stringify(b.arguments ?? {})).slice(0, 200);
      } catch {
        /* best-effort argument preview only */
      }
      parts.push(`[called ${b.name}(${args})]`);
    }
    // "thinking" blocks deliberately skipped — see module comment.
  }
  return parts.join(" ").slice(0, PER_MESSAGE_CHAR_CAP);
}

/** Parse one JSONL line into a rendered turn, or null if not a renderable message. */
function renderLine(line: string): string | null {
  if (!line.trim()) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null; // one bad line must never take down the whole read
  }
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return null;
  const m = entry.message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "";
  if (role === "user") {
    const text = summarizeContent(m.content);
    return text ? `USER: ${text}` : null;
  }
  if (role === "assistant") {
    const text = summarizeContent(m.content);
    return text ? `ASSISTANT: ${text}` : null;
  }
  if (role === "toolResult") {
    const toolName = typeof m.toolName === "string" ? m.toolName : "tool";
    const text = summarizeContent(m.content);
    return text ? `TOOL RESULT (${toolName}): ${text}` : null;
  }
  return null;
}

/**
 * Reads and renders a session transcript file into a judge-readable summary.
 * Never throws — see module comment.
 */
export function readSessionTranscriptSummary(sessionFilePath: string, maxChars: number): TranscriptSummary {
  let raw: string;
  try {
    raw = readFileSync(sessionFilePath, "utf8");
  } catch {
    return { text: "", turnCount: 0, truncated: false };
  }
  const turns: string[] = [];
  for (const line of raw.split("\n")) {
    const rendered = renderLine(line);
    if (rendered) turns.push(rendered);
  }
  const full = turns.join("\n");
  if (full.length <= maxChars) {
    return { text: full, turnCount: turns.length, truncated: false };
  }
  // Keep the TAIL (most recent turns) — drop from the oldest end.
  const tail = full.slice(full.length - maxChars);
  const firstNewline = tail.indexOf("\n");
  const clean = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;
  return { text: clean, turnCount: turns.length, truncated: true };
}

/**
 * Fallback session-file path construction, used ONLY when the plugin
 * runtime's own session.resolveSessionFilePath is unavailable — defensive
 * against exactly the kind of vendor/openclaw version drift that has
 * previously misdirected debugging in this deployment (CLAW-076's own
 * postmortem). Matches the on-disk convention openclaw actually uses today:
 * ~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl. Kept as a single-
 * purpose safety net, never the preferred path — see reviewer.ts.
 */
export function fallbackSessionFilePath(sessionId: string, agentId: string): string {
  return join(homedir(), ".openclaw", "agents", agentId || "main", "sessions", `${sessionId}.jsonl`);
}
