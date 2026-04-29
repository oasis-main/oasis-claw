import { appendTrailEvent } from "../trail.js";

export type SleepToolConfig = {
  swarmDir: string;
};

/**
 * sleep tool — agent voluntarily yields control for a configured duration.
 *
 * What this stub does:
 *   - Validates the requested duration
 *   - Writes a SLEEP event to .swarm/trail.log
 *   - Returns immediately with the requested resumeAt timestamp
 *
 * What full host-integration would add (TODO, ORG-050):
 *   - Signal the openclaw runtime to actually pause the loop
 *   - Schedule a re-invocation at resumeAt via cron / systemd-timer / setTimeout
 *   - Provide a wake-reason channel so external events can resume earlier
 *
 * In its current form the tool is honest: it announces intent, persists it
 * to the trail, and lets the caller layer in the scheduler. The agent's
 * subsequent reasoning sees a well-formed return value rather than a stub
 * marker, which is what we want for testing the prompt path end-to-end.
 */
export function createSleepTool(config: SleepToolConfig) {
  return {
    name: "sleep",
    description:
      "Voluntarily yield for the requested duration. Use when waiting on external state (Telegram approval, polling), rate-limit backoff, or any 'check back later' pattern. Returns the scheduled resume timestamp.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["reason", "resumeAfterMs"],
      properties: {
        reason: {
          type: "string",
          description: "Short human-readable reason — appears in trail.log and the resume notification.",
        },
        resumeAfterMs: {
          type: "number",
          minimum: 60_000,
          maximum: 3_600_000,
          description:
            "Milliseconds to sleep before resuming. Clamped to [60s, 1h] for safety; longer waits should use schedule-tasks.",
        },
      },
    },
    async invoke(args: { reason: string; resumeAfterMs: number }) {
      const clamped = Math.max(60_000, Math.min(3_600_000, args.resumeAfterMs));
      const resumeAt = new Date(Date.now() + clamped).toISOString();
      const trail = appendTrailEvent(config.swarmDir, {
        kind: "SLEEP",
        reason: args.reason,
        resumeAfterMs: clamped,
        resumeAt,
      });
      return {
        status: "yielded",
        resumeAt,
        clampedMs: clamped,
        trailWritten: trail.written,
        trailPath: trail.path,
        hostIntegrationNote:
          "This stub does not actually pause the agent loop. Wire scheduler-driven re-invocation per oasis-x ORG-050 to make the yield real.",
      };
    },
  };
}
