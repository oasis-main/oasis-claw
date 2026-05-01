/**
 * Sleep schedule sidecar — machine-readable file for host scheduler integration.
 *
 * When the agent calls `sleep()`, the plugin writes sleep-schedule.json in addition
 * to the trail.log entry. An external scheduler (cron, systemd-timer, Lambda EventBridge)
 * polls this file and re-invokes the openclaw CLI session at `resumeAt`.
 *
 * File location: <swarmDir>/sleep-schedule.json
 * Cleared on: agent wakeup (scheduler deletes after successful re-invocation),
 *             or when the agent calls sleep() again (overwrite).
 */

import fs from "node:fs";
import path from "node:path";

export type SleepSchedule = {
  kind: "SLEEP";
  /** ISO timestamp when the sleep was requested. */
  scheduledAt: string;
  /** ISO timestamp at which the agent should be re-invoked. */
  resumeAt: string;
  /** Original requested duration in ms (after clamping). */
  resumeAfterMs: number;
  /** Human-readable reason for sleeping — shown in wake notification. */
  reason: string;
  /**
   * Suggested shell command for the scheduler to run at resumeAt.
   * The scheduler MAY override this with its own invocation strategy.
   * Example: "openclaw run --session <sessionId>"
   */
  suggestedResumeCommand?: string;
};

const SCHEDULE_FILENAME = "sleep-schedule.json";

export function writeSleepSchedule(
  swarmDir: string,
  schedule: SleepSchedule,
): { written: boolean; path: string; error?: string } {
  const filePath = path.join(swarmDir, SCHEDULE_FILENAME);
  try {
    fs.mkdirSync(swarmDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(schedule, null, 2) + "\n", "utf8");
    return { written: true, path: filePath };
  } catch (err) {
    return {
      written: false,
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function readSleepSchedule(swarmDir: string): SleepSchedule | null {
  const filePath = path.join(swarmDir, SCHEDULE_FILENAME);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as SleepSchedule;
    if (parsed.kind !== "SLEEP" || !parsed.resumeAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSleepSchedule(swarmDir: string): { cleared: boolean; path: string } {
  const filePath = path.join(swarmDir, SCHEDULE_FILENAME);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return { cleared: true, path: filePath };
    }
    return { cleared: false, path: filePath };
  } catch {
    return { cleared: false, path: filePath };
  }
}

/** True if there's an unexpired sleep schedule. */
export function isSleepActive(swarmDir: string): boolean {
  const schedule = readSleepSchedule(swarmDir);
  if (!schedule) return false;
  return new Date(schedule.resumeAt) > new Date();
}
