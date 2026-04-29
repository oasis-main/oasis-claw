import fs from "node:fs";
import path from "node:path";
import { appendTrailEvent } from "../trail.js";

export type CompactToolConfig = {
  swarmDir: string;
};

/**
 * compact tool — graceful handoff at context-ceiling.
 *
 * What this stub does:
 *   - Appends a HANDOFF section to .swarm/state.md with the agent-supplied
 *     handoff note + ISO timestamp
 *   - Writes a COMPACT event to .swarm/trail.log
 *   - Returns the snapshot path so the caller (or operator) can verify
 *
 * What full integration would add (TODO, ORG-050):
 *   - Signal the openclaw runtime to actually finish the current turn
 *     and start a fresh session with empty context
 *   - Auto-load the freshly-written state.md into the new session's memory
 *     (this happens automatically once dot-swarm is wired, since dot-swarm
 *     reads state.md as a memory prompt supplement)
 *
 * The split is deliberate: agent-primitives owns the *content* of the
 * handoff (what to write where), and host integration owns the *lifecycle*
 * (when to actually reset). This matches how Claude Code's compact tool
 * works — the tool emits the snapshot, the harness handles the reset.
 */
export function createCompactTool(config: CompactToolConfig) {
  return {
    name: "compact",
    description:
      "Graceful handoff at context-ceiling. Writes a snapshot of the current task state to .swarm/state.md so a fresh session can resume. Use BEFORE the context window is exhausted, not after.",
    inputSchema: {
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
    async invoke(args: { handoffNote: string; sessionTag?: string }) {
      const ts = new Date().toISOString();
      const tag = args.sessionTag ?? `compact-${ts}`;
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

      const trail = appendTrailEvent(config.swarmDir, {
        kind: "COMPACT",
        sessionTag: tag,
        handoffNoteBytes: args.handoffNote.length,
        snapshotPath: statePath,
        snapshotWritten,
      });

      return {
        status: snapshotWritten ? "snapshot_written" : "snapshot_failed",
        snapshotPath: statePath,
        sessionTag: tag,
        timestamp: ts,
        snapshotWritten,
        snapshotError,
        trailWritten: trail.written,
        hostIntegrationNote:
          "This stub writes the snapshot but does NOT signal the runtime to reset context. Wire the harness reset per oasis-x ORG-050. Once dot-swarm is enabled, the next session will pick up state.md automatically via registerMemoryPromptSupplement.",
      };
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
    `*Compacted at ${ts} via agent-primitives \`compact\` tool.*`,
    "",
    body.trim(),
    "",
  ].join("\n");
}
