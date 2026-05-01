import { writeSleepSchedule } from "../schedule.js";
import { appendTrailEvent } from "../trail.js";

export type SleepToolConfig = {
  swarmDir: string;
  /**
   * Optional shell command template to suggest to the scheduler.
   * Use {sessionId} as a placeholder. Default: "openclaw run --session {sessionId}"
   */
  resumeCommandTemplate?: string;
};

/**
 * sleep tool — agent voluntarily yields control for a configured duration.
 *
 * FS-side (done):
 *   - Validates + clamps the requested duration [60s, 1h]
 *   - Writes a SLEEP event to .swarm/trail.log
 *   - Writes .swarm/sleep-schedule.json (machine-readable sidecar for host scheduler)
 *
 * Host integration wiring (ORG-050):
 *   - A sidecar process (cron / systemd-timer / Lambda EventBridge) polls
 *     sleep-schedule.json and re-invokes the openclaw CLI session at `resumeAt`
 *   - On wake: the scheduler deletes sleep-schedule.json, invokes openclaw,
 *     and the agent reads the trail.log SLEEP entry to understand why it was woken
 *   - Early resumption: Telegram callback or S3 inbox event can call
 *     clearSleepSchedule() + re-invoke openclaw before resumeAt
 */
export function createSleepTool(config: SleepToolConfig) {
  const resumeCommandTemplate =
    config.resumeCommandTemplate ?? "openclaw run --session {sessionId}";

  return {
    name: "sleep",
    description: [
      "Voluntarily yield for the requested duration.",
      "Use when waiting on external state (Telegram approval, polling), rate-limit backoff,",
      "or any 'check back later' pattern.",
      "Writes a machine-readable sleep-schedule.json that the host scheduler reads to",
      "re-invoke this session at resumeAt.",
      "Returns the scheduled resume timestamp.",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["reason", "resumeAfterMs"],
      properties: {
        reason: {
          type: "string",
          description:
            "Short human-readable reason — appears in trail.log, sleep-schedule.json, and the resume notification.",
        },
        resumeAfterMs: {
          type: "number",
          minimum: 60_000,
          maximum: 3_600_000,
          description:
            "Milliseconds to sleep before resuming. Clamped to [60 000, 3 600 000]. Longer waits should use schedule-tasks.",
        },
        sessionId: {
          type: "string",
          description:
            "Optional current session identifier — included in sleep-schedule.json so the scheduler knows which session to resume.",
        },
      },
    },

    async invoke(args: { reason: string; resumeAfterMs: number; sessionId?: string }) {
      const clamped = Math.max(60_000, Math.min(3_600_000, args.resumeAfterMs));
      const scheduledAt = new Date().toISOString();
      const resumeAt = new Date(Date.now() + clamped).toISOString();

      // Write machine-readable sidecar for host scheduler
      const suggestedResumeCommand = args.sessionId
        ? resumeCommandTemplate.replace("{sessionId}", args.sessionId)
        : undefined;

      const schedule = writeSleepSchedule(config.swarmDir, {
        kind: "SLEEP",
        scheduledAt,
        resumeAt,
        resumeAfterMs: clamped,
        reason: args.reason,
        suggestedResumeCommand,
      });

      // Append trail event
      const trail = appendTrailEvent(config.swarmDir, {
        kind: "SLEEP",
        reason: args.reason,
        resumeAfterMs: clamped,
        resumeAt,
        sessionId: args.sessionId ?? null,
        scheduleWritten: schedule.written,
      });

      return {
        status: "yielded",
        resumeAt,
        clampedMs: clamped,
        schedulePath: schedule.path,
        scheduleWritten: schedule.written,
        trailWritten: trail.written,
        trailPath: trail.path,
        hostIntegrationNote:
          "sleep-schedule.json written. Wire a host scheduler (cron/systemd/EventBridge) to poll this file and re-invoke openclaw at resumeAt. See oasis-x ORG-050.",
      };
    },
  };
}
