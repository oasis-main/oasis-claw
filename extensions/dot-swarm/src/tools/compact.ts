import fs from "node:fs";
import path from "node:path";

export type CompactToolConfig = {
  swarmDir: string;
  /**
   * When set, every written handoff is tagged "<botKey>: <rest>" so
   * compaction-provider.ts's readLatestHandoff can find this bot's own
   * notes on a swarmDir shared with another bot, without ever matching the
   * other bot's notes. See the doc comment on readLatestHandoff.
   */
  botKey?: string;
};

/**
 * compact tool — graceful handoff at context-ceiling.
 *
 * Appends a HANDOFF section to .swarm/state.md with the agent-supplied handoff
 * note + ISO timestamp. The SwarmCompactionProvider (compaction-provider.ts)
 * reads that section back at compaction time, so when openclaw's context limit
 * triggers auto-compaction the fresh context starts from the agent's own
 * snapshot instead of a generic summarizeInStages() summary. dot-swarm also
 * injects state.md into the memory prompt each turn, so the handoff is visible
 * to the next session regardless of compaction.
 *
 * The split is deliberate: this tool owns the *content* of the handoff (what to
 * write), the compaction provider owns serving it back at the *lifecycle* moment.
 */
export function createCompactTool(config: CompactToolConfig) {
  return {
    name: "compact",
    description:
      "Graceful handoff at context-ceiling. Writes a snapshot of the current task state to .swarm/state.md so a fresh session can resume. Use BEFORE the context window is exhausted, not after.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["handoffNote"],
      properties: {
        handoffNote: {
          type: "string",
          minLength: 50,
          description:
            "Markdown-formatted handoff note. Should describe: current task, what's been done, what's left, blockers, and any non-obvious context the next session needs. Aim for 200-1000 words — long enough to be useful, short enough to be readable.",
        },
        sessionTag: {
          type: "string",
          description: "Optional session identifier to include in the snapshot header (default: timestamp).",
        },
      },
    },
    async execute(_toolCallId: string, args: { handoffNote: string; sessionTag?: string }) {
      const ts = new Date().toISOString();
      const rawTag = args.sessionTag ?? `compact-${ts}`;
      const tag = config.botKey ? `${config.botKey}: ${rawTag}` : rawTag;
      const snapshot = renderHandoffSection(tag, ts, args.handoffNote);

      const statePath = path.join(config.swarmDir, "state.md");
      let snapshotWritten = false;
      let snapshotError: string | undefined;
      try {
        fs.mkdirSync(config.swarmDir, { recursive: true });
        fs.appendFileSync(statePath, snapshot, "utf8");
        snapshotWritten = true;
      } catch (err) {
        snapshotError = err instanceof Error ? err.message : String(err);
      }

      const result = {
        status: snapshotWritten ? "snapshot_written" : "snapshot_failed",
        snapshotPath: statePath,
        sessionTag: tag,
        timestamp: ts,
        snapshotWritten,
        snapshotError,
        note:
          "Handoff written to .swarm/state.md. The swarm-compact compaction provider serves this section back when openclaw auto-compacts at the context ceiling, and dot-swarm injects state.md into the memory prompt each turn.",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  };
}

function renderHandoffSection(tag: string, ts: string, body: string): string {
  return [
    "",
    "---",
    "",
    `## Handoff Note — ${tag}`,
    "",
    `*Compacted at ${ts} via the dot-swarm \`compact\` tool.*`,
    "",
    body.trim(),
    "",
  ].join("\n");
}
