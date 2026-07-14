/**
 * Durable JSON state for the sleep cycle (survives gateway restarts so a
 * crash mid-cycle can't strand the mutex — see STALE_LOCK_MS backstop).
 * Atomic write via tmp + rename, same discipline as openclaw's own stores.
 */

import fs from "node:fs";
import path from "node:path";
import { initialState, type SleepCycleState } from "./mutex.js";

const FILE_NAME = "sleep-cycle-state.json";

/**
 * Read the persisted state fresh from disk (no caching). Used by the waking
 * supplement so it sees writes made by the sleep_deep tool, which may run in a
 * different StateStore instance (or a different turn) than the supplement.
 */
export function loadState(stateDir: string): SleepCycleState {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(stateDir, FILE_NAME), "utf-8"),
    ) as SleepCycleState;
    if (parsed && typeof parsed.state === "string") {
      return { ...parsed, queue: Array.isArray(parsed.queue) ? parsed.queue : [] };
    }
  } catch {
    /* first boot / unreadable */
  }
  return initialState();
}

export class StateStore {
  private readonly filePath: string;
  state: SleepCycleState;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, FILE_NAME);
    this.state = this.load();
  }

  private load(): SleepCycleState {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as SleepCycleState;
      if (parsed && typeof parsed.state === "string" && Array.isArray(parsed.queue)) {
        return parsed;
      }
    } catch {
      // first boot, or unreadable — start fresh
    }
    return initialState();
  }

  save(next: SleepCycleState): void {
    this.state = next;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Persistence is best-effort; in-memory state remains authoritative
      // for this process lifetime.
    }
  }
}
