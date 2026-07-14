/**
 * Sleep-state machine + task/message mutex.
 *
 * The organism analogy (per the fleet design note):
 *   awake       — normal operation
 *   dozing      — wind-down begun; MUTEX LOCKED; waiting for/holding idle
 *   dreaming    — memory-core consolidation window; MUTEX LOCKED
 *   deep_sleep  — session compact + reset in flight; MUTEX LOCKED
 *   light_sleep — consolidation done; MUTEX RELEASED. Resting but ready:
 *                 inbound messages dispatch normally ("wakeable for
 *                 emergencies"), the bot just isn't self-waking.
 *
 * The lock is held ONLY across dozing -> dreaming -> deep_sleep so nothing
 * overlaps memory consolidation, compaction, and the session restart. It is
 * released the moment deep sleep completes — before light sleep — exactly
 * mirroring deep inactivity vs rest-but-ready in biological sleep.
 *
 * Messages arriving while locked are QUEUED (never dropped) and replayed
 * after release. Pure state transitions live here; IO lives in cycle.ts.
 */

export type SleepState = "awake" | "dozing" | "dreaming" | "deep_sleep" | "light_sleep";

const LOCKED: ReadonlySet<SleepState> = new Set(["dozing", "dreaming", "deep_sleep"]);

export type QueuedInbound = {
  content: string;
  channel?: string;
  sessionKey?: string;
  senderId?: string;
  queuedAtMs: number;
};

export type ArchivedSessionRef = {
  sessionKey: string;
  /** Transcript path at capture time (pre-reset); reset renames it in place. */
  transcriptPath?: string;
  /** Post-reset archive path when the rename could be located. */
  archivePath?: string;
};

export type MemoryHit = {
  source: string;
  title: string;
  snippet: string;
  score: number;
};

export type LastCycleRecord = {
  dateKey: string;
  completedAtMs: number;
  /** Tail excerpt of each session captured before reset — the wakeup handoff. */
  handoff: string;
  archives: ArchivedSessionRef[];
  memoryHits: MemoryHit[];
};

export type SleepCycleState = {
  state: SleepState;
  lockedSinceMs?: number;
  /** Once-per-day guard: local date key of the last started cycle. */
  lastCycleDate?: string;
  queue: QueuedInbound[];
  lastCycle?: LastCycleRecord;
};

export const MAX_QUEUE = 50;

/** Crash backstop: a lock older than this is force-released on the next tick. */
export const STALE_LOCK_MS = 3 * 60 * 60_000;

export function initialState(): SleepCycleState {
  return { state: "awake", queue: [] };
}

export function isLocked(s: SleepCycleState): boolean {
  return LOCKED.has(s.state);
}

/** Enter dozing and take the mutex. No-op if already locked. */
export function acquireLock(s: SleepCycleState, nowMs: number, dateKey: string): SleepCycleState {
  if (isLocked(s)) {
    return s;
  }
  return { ...s, state: "dozing", lockedSinceMs: nowMs, lastCycleDate: dateKey };
}

/** Move between locked stages (dozing -> dreaming -> deep_sleep). */
export function advanceStage(s: SleepCycleState, to: "dreaming" | "deep_sleep"): SleepCycleState {
  if (!isLocked(s)) {
    return s;
  }
  return { ...s, state: to };
}

/**
 * Release the mutex into light_sleep, draining the queue for replay.
 * Returns the drained messages; state keeps an empty queue.
 */
export function releaseLock(s: SleepCycleState): {
  state: SleepCycleState;
  drained: QueuedInbound[];
} {
  const drained = s.queue;
  return {
    state: { ...s, state: "light_sleep", lockedSinceMs: undefined, queue: [] },
    drained,
  };
}

/** Morning transition. Only meaningful from light_sleep (or a stale lock). */
export function wake(s: SleepCycleState): SleepCycleState {
  if (s.state === "awake") {
    return s;
  }
  return { ...s, state: "awake", lockedSinceMs: undefined };
}

/** Queue an inbound message that arrived while locked (bounded, FIFO drop-oldest). */
export function queueInbound(
  s: SleepCycleState,
  msg: QueuedInbound,
  cap: number = MAX_QUEUE,
): SleepCycleState {
  const queue = [...s.queue, msg];
  while (queue.length > cap) {
    queue.shift();
  }
  return { ...s, queue };
}

/** True when a locked state has out-lived the crash backstop. */
export function isLockStale(s: SleepCycleState, nowMs: number): boolean {
  return isLocked(s) && typeof s.lockedSinceMs === "number"
    ? nowMs - s.lockedSinceMs > STALE_LOCK_MS
    : false;
}
