import { readSwarmSnapshot, renderSnapshotAsPromptLines } from "../swarm-reader.js";

export type SwarmReadToolConfig = {
  swarmDir: string;
  includeFiles: string[];
  maxBytes: number;
};

/**
 * swarm_read agent tool — re-read the .swarm/ files mid-session.
 *
 * The plugin already injects state on session start via
 * registerMemoryPromptSupplement. This tool is the explicit escape
 * hatch when the agent (or a sibling agent) has updated the .swarm/
 * files during the session and we want fresh context without
 * waiting for a new session.
 */
export function createSwarmReadTool(config: SwarmReadToolConfig) {
  return {
    name: "swarm_read",
    description:
      "Re-read the .swarm/ coordination files (state.md, queue.md, ...) and return them as the latest snapshot. Use this when stigmergic state may have changed mid-session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Optional override of files to read; defaults to the plugin's configured includeFiles.",
        },
      },
    },
    async invoke(args: { files?: string[] }) {
      const includeFiles = args.files ?? config.includeFiles;
      const snapshot = readSwarmSnapshot({
        swarmDir: config.swarmDir,
        includeFiles,
        maxBytes: config.maxBytes,
      });
      const lines = renderSnapshotAsPromptLines(config.swarmDir, snapshot);
      return {
        swarmDir: config.swarmDir,
        files: snapshot.map((f) => ({
          filename: f.filename,
          exists: f.exists,
          bytes: f.bytes,
          truncated: f.truncated,
        })),
        rendered: lines.join("\n"),
      };
    },
  };
}
