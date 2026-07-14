/**
 * before_reset hook — the AUTOMATIC capture path.
 *
 * openclaw already resets long-lived sessions on its own schedule (the native
 * `session.reset` policy, mode "daily"/"idle") — it archives the transcript to
 * `<file>.reset.<ts>` and starts a fresh session with no plugin, no cron, and
 * no admin scope. That native reset is what actually caps transcript growth
 * (the prompt-cache cost fix); we do NOT reinvent it.
 *
 * What openclaw's reset does NOT do is carry continuity forward. That's this
 * plugin's job: when a scheduled reset is about to fire, this hook captures the
 * mechanical handoff tail from the messages being archived, vector-ranks a few
 * relevant memories (one oasis-semantics embed burst, zero LLM), and writes
 * the sleep-cycle state file. The waking-summary supplement then injects that
 * into the fresh session.
 *
 * We only capture for openclaw's SCHEDULED conversational resets ("daily" /
 * "idle") — not for cron/subagent/compaction/delete resets, which carry no
 * handoff worth staging. The on-demand `sleep_deep` tool has its own
 * self-contained capture (runDeepSleep), so the two paths never double-write:
 * the tool's manual reset reports reason "reset"/"new", which this hook skips.
 */

import type { SleepDeepConfig } from "./deep-tool.js";
import { collectMemoryChunks, rankMemoryHits } from "./memory-rank.js";
import type { ArchivedSessionRef, MemoryHit } from "./mutex.js";
import { dateKeyInTimeZone } from "./schedule.js";
import type { StateStore } from "./state-store.js";
import { flattenContent } from "./transcripts.js";

/** openclaw scheduled conversational resets we stage a waking summary for. */
const SCHEDULED_RESET_REASONS = new Set(["daily", "idle"]);

export type BeforeResetEvent = {
  sessionFile?: string;
  messages?: unknown[];
  reason?: string;
};

export type BeforeResetDeps = {
  cfg: SleepDeepConfig;
  workspaceDir: string;
  store: StateStore;
  nowMs: () => number;
  log?: (msg: string) => void;
};

type LooseMessage = {
  role?: string;
  content?: unknown;
  message?: { role?: string; content?: unknown };
  type?: string;
};

/**
 * Format the last few user/assistant turns of an in-memory message array into
 * the plain-text handoff tail. Mirrors transcripts.extractTail but over the
 * messages the before_reset event hands us (no file read).
 */
export function messagesToHandoff(
  messages: unknown[],
  opts?: { maxTurns?: number; maxChars?: number },
): string {
  const maxTurns = opts?.maxTurns ?? 12;
  const maxChars = opts?.maxChars ?? 1_600;
  const turns: string[] = [];
  for (let i = messages.length - 1; i >= 0 && turns.length < maxTurns; i--) {
    const raw = messages[i] as LooseMessage;
    // Accept {role,content}, {message:{role,content}}, or the transcript
    // {type:"message",message:{...}} record shape.
    const msg = raw?.message ?? raw;
    const role = msg?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = flattenContent(msg?.content);
    if (text) {
      turns.push(`${role}: ${text.slice(0, 400)}`);
    }
  }
  return turns.reverse().join("\n").slice(-maxChars);
}

/**
 * Handle a before_reset event. Returns true if it staged a waking summary,
 * false if it skipped (wrong reason / empty handoff). Never throws — a capture
 * failure must never block or corrupt openclaw's reset.
 */
export async function handleBeforeReset(
  event: BeforeResetEvent,
  deps: BeforeResetDeps,
): Promise<boolean> {
  const log = deps.log ?? (() => {});
  try {
    if (!event.reason || !SCHEDULED_RESET_REASONS.has(event.reason)) {
      return false;
    }
    const handoff = messagesToHandoff(event.messages ?? []);
    if (!handoff) {
      return false;
    }

    let memoryHits: MemoryHit[] = [];
    if (deps.cfg.wakingSummary.enabled) {
      try {
        memoryHits = await rankMemoryHits({
          endpoint: deps.cfg.semanticsEndpoint,
          model: deps.cfg.semanticsModel,
          query: handoff.slice(0, 1_500),
          chunks: collectMemoryChunks(deps.workspaceDir),
          topK: deps.cfg.wakingSummary.memoryHits,
        });
      } catch (err) {
        log(`before_reset: memory rank failed: ${String(err)}`);
      }
    }

    // The archive doesn't exist yet at before_reset (the rename happens after),
    // so we point at the live transcript file; the supplement notes it as the
    // most recent archived transcript.
    const archives: ArchivedSessionRef[] = event.sessionFile
      ? [{ sessionKey: "reset:" + event.reason, transcriptPath: event.sessionFile }]
      : [];

    const dateKey = dateKeyInTimeZone(deps.nowMs(), deps.cfg.timezone);
    deps.store.save({
      ...deps.store.state,
      state: "light_sleep",
      lastCycleDate: dateKey,
      queue: deps.store.state.queue ?? [],
      lastCycle: { dateKey, completedAtMs: deps.nowMs(), handoff, archives, memoryHits },
    });
    log(`before_reset: staged waking summary (${memoryHits.length} memory hit(s), reason=${event.reason})`);
    return true;
  } catch (err) {
    log(`before_reset: capture failed (non-fatal): ${String(err)}`);
    return false;
  }
}
