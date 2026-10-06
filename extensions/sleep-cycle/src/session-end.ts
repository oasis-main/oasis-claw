/**
 * session_end hook — the path openclaw's NIGHTLY rollover actually takes.
 *
 * Found 2026-10-06: openclaw fires `before_reset` only for explicit resets
 * (reason "new" / "reset" from /new, /reset or sessions.reset). The scheduled
 * daily/idle rollover happens lazily on the next inbound message and fires
 * `session_end` with reason = the freshness staleReason ("daily" / "idle") and
 * the previous transcript's path, never `before_reset`. Our before_reset
 * handler only accepted "daily"/"idle", so the waking summary never staged:
 * House and Kolmogorov had no sleep-cycle state file at all, and Nimbus's was
 * last written 2026-07-14.
 *
 * session_end is fire-and-forget in openclaw, so the first turn of the new
 * session can race this capture; later turns see the staged summary.
 */

import fs from "node:fs";
import path from "node:path";
import { type BeforeResetDeps, stageWakingSummary } from "./before-reset.js";
import { extractTail } from "./transcripts.js";

const ROLLOVER_REASONS = new Set(["daily", "idle"]);

export type SessionEndEvent = {
  sessionId?: string;
  sessionKey?: string;
  reason?: string;
  sessionFile?: string;
  transcriptArchived?: boolean;
};

/**
 * Resolve where the previous transcript lives now. openclaw archives it in
 * place as `<file>.reset.<ts>` (or `.deleted.` / `.bak`) during rollover, so
 * the event's path may no longer exist. Pure apart from directory reads.
 */
export function resolveTranscript(sessionFile: string | undefined): string | undefined {
  if (!sessionFile) return undefined;
  if (fs.existsSync(sessionFile)) return sessionFile;
  const dir = path.dirname(sessionFile);
  const base = path.basename(sessionFile);
  try {
    const match = fs
      .readdirSync(dir)
      .filter((e) => e.startsWith(base) && /\.(reset|deleted|bak)/.test(e))
      .sort()
      .pop();
    return match ? path.join(dir, match) : undefined;
  } catch {
    return undefined;
  }
}

export function isRolloverSessionEnd(event: SessionEndEvent): boolean {
  return Boolean(event.reason && ROLLOVER_REASONS.has(event.reason));
}

/** Handle a session_end event. Never throws. True when a summary was staged. */
export async function handleSessionEnd(event: SessionEndEvent, deps: BeforeResetDeps): Promise<boolean> {
  const log = deps.log ?? (() => {});
  try {
    if (!isRolloverSessionEnd(event)) return false;
    const transcript = resolveTranscript(event.sessionFile);
    if (!transcript) {
      log(`session_end: no transcript found for reason=${event.reason}`);
      return false;
    }
    const handoff = extractTail(transcript);
    return await stageWakingSummary(handoff, transcript, event.reason ?? "daily", deps, "session_end");
  } catch (err) {
    log(`session_end: capture failed (non-fatal): ${String(err)}`);
    return false;
  }
}
