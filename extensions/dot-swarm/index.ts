import fs from "node:fs";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { z } from "zod";
import { createSwarmCompactionProvider } from "./src/compaction-provider.js";
import { readSwarmSnapshot, renderSnapshotAsPromptLines } from "./src/swarm-reader.js";
import { createCompactTool } from "./src/tools/compact.js";
import { createSwarmReadTool } from "./src/tools/swarm-read.js";

const configSchema = z.object({
  swarmDir: z.string().optional(),
  includeFiles: z.array(z.string()).optional(),
  maxBytes: z.number().optional(),
  registerSwarmReadTool: z.boolean().optional(),
});

export type DotSwarmConfig = z.infer<typeof configSchema>;

const DEFAULT_INCLUDE = ["state.md", "queue.md"];
const DEFAULT_MAX_BYTES = 32_768;

function resolveSwarmDir(configured: string | undefined): string {
  if (configured) {
    return configured;
  }
  const cwdSwarm = path.join(process.cwd(), ".swarm");
  if (fs.existsSync(cwdSwarm)) {
    return cwdSwarm;
  }
  return path.join(process.env.HOME ?? "/tmp", ".openclaw", ".swarm");
}

const plugin = {
  id: "dot-swarm",
  name: "Dot-Swarm",
  description:
    "Shared .swarm/ stigmergy: injects coordination state (state.md + queue.md) " +
    "into the agent's memory prompt as a non-exclusive supplement, provides the " +
    "swarm_read + compact tools, and registers the swarm-compact CompactionProvider " +
    "(handoff-driven context compaction backed by .swarm/state.md).",

  configSchema: {
    parse(raw: unknown) {
      return configSchema.parse(raw ?? {});
    },
  },

  register(api: OpenClawPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig ?? {});
    const swarmDir = resolveSwarmDir(cfg.swarmDir);
    const includeFiles = cfg.includeFiles ?? DEFAULT_INCLUDE;
    const maxBytes = cfg.maxBytes ?? DEFAULT_MAX_BYTES;
    const wantsSwarmReadTool = cfg.registerSwarmReadTool ?? true;

    // Memory prompt supplement — non-exclusive. Coexists with memory-core /
    // memory-lancedb / memory-wiki / active-memory. Each session prepares the
    // memory section by calling all registered supplements.
    api.registerMemoryPromptSupplement(({ availableTools: _availableTools }) => {
      const snapshot = readSwarmSnapshot({ swarmDir, includeFiles, maxBytes });
      return renderSnapshotAsPromptLines(swarmDir, snapshot);
    });

    if (wantsSwarmReadTool) {
      api.registerTool(
        createSwarmReadTool({ swarmDir, includeFiles, maxBytes }),
        { name: "swarm_read" },
      );
    }

    // compact tool — the agent writes a HANDOFF section into .swarm/state.md.
    api.registerTool(createCompactTool({ swarmDir }), { name: "compact" });

    // swarm-compact CompactionProvider — serves the latest HANDOFF back to the
    // runtime at context-ceiling compaction. Inert unless the agent config sets
    // agents.defaults.compaction.provider = "swarm-compact" (the runtime
    // entrypoint pins exactly that).
    api.registerCompactionProvider(createSwarmCompactionProvider({ swarmDir }));

    api.logger.info("dot-swarm plugin loaded", {
      swarmDir,
      includeFiles,
      maxBytes,
      swarmReadToolRegistered: wantsSwarmReadTool,
      tools: wantsSwarmReadTool ? ["swarm_read", "compact"] : ["compact"],
      compactionProvider: "swarm-compact (reads state.md)",
      swarmDirExists: fs.existsSync(swarmDir),
    });
  },
};

export default plugin;
