/**
 * Waking summary — injected into the fresh session's memory prompt section
 * via registerMemoryPromptSupplement (the dot-swarm pattern; non-exclusive,
 * coexists with memory-core and dot-swarm supplements).
 *
 * Contents, per the fleet design: a summary of the most recent session
 * (the mechanical handoff tail captured at deep sleep), pointers to the
 * archived raw transcripts, and a limited number of potentially relevant
 * memories fetched by vector search (ranked once at cycle time).
 *
 * Injection is time-gated: mornings only (until injectUntilHour local), and
 * only for the cycle that ran last night — stale cycles never leak forward.
 */

import { minutesInTimeZone } from "./schedule.js";
import type { SleepCycleState } from "./mutex.js";

const MAX_LINES_BYTES = 6_000;

export type WakingConfig = {
  timezone: string;
  wakingSummary: {
    enabled: boolean;
    memoryHits: number;
    transcriptPointers: number;
    injectUntilHour: number;
  };
};

export function buildWakingLines(
  state: SleepCycleState,
  cfg: WakingConfig,
  nowMs: number,
): string[] {
  if (!cfg.wakingSummary.enabled) {
    return [];
  }
  const cycle = state.lastCycle;
  if (!cycle) {
    return [];
  }
  // Fresh only: within 20h of completion AND before the morning cutoff.
  if (nowMs - cycle.completedAtMs > 20 * 60 * 60_000) {
    return [];
  }
  const localMinutes = minutesInTimeZone(nowMs, cfg.timezone);
  if (localMinutes !== null && localMinutes >= cfg.wakingSummary.injectUntilHour * 60) {
    return [];
  }

  const lines: string[] = [
    "## Waking context (sleep-cycle)",
    `Overnight consolidation completed ${new Date(cycle.completedAtMs).toISOString()}. ` +
      "This is a fresh session; yesterday's context below.",
  ];

  if (cycle.handoff) {
    lines.push("", "### Where we left off (last session tail)", cycle.handoff);
  }

  if (cfg.wakingSummary.transcriptPointers > 0 && cycle.archives.length > 0) {
    lines.push("", "### Archived raw transcripts (read with session tools if needed)");
    for (const a of cycle.archives.slice(0, cfg.wakingSummary.transcriptPointers)) {
      lines.push(`- ${a.sessionKey}: ${a.archivePath ?? a.transcriptPath ?? "(path unknown)"}`);
    }
  }

  if (cycle.memoryHits.length > 0) {
    lines.push("", "### Possibly relevant memories (vector-ranked at wind-down)");
    for (const hit of cycle.memoryHits) {
      lines.push(`- [${hit.score.toFixed(2)}] ${hit.title} — ${hit.snippet}`);
    }
  }

  // Byte cap so the supplement can never bloat the prompt.
  let total = 0;
  const capped: string[] = [];
  for (const line of lines) {
    total += line.length + 1;
    if (total > MAX_LINES_BYTES) {
      capped.push("… (waking context truncated)");
      break;
    }
    capped.push(line);
  }
  return capped;
}
