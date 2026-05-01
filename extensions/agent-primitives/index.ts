import fs from "node:fs";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { z } from "zod";
import { createSwarmCompactionProvider } from "./src/compaction-provider.js";
import { createCompactTool } from "./src/tools/compact.js";
import { createDreamTool } from "./src/tools/dream.js";
import { createSleepTool } from "./src/tools/sleep.js";

const configSchema = z.object({
  swarmDir: z.string().optional(),
  historyDir: z.string().optional(),
  /**
   * Shell command template for the sleep scheduler.
   * Use {sessionId} as a placeholder. Default: "openclaw run --session {sessionId}"
   */
  resumeCommandTemplate: z.string().optional(),
});

export type AgentPrimitivesConfig = z.infer<typeof configSchema>;

function resolveSwarmDir(configured: string | undefined): string {
  if (configured) return configured;
  const cwdSwarm = path.join(process.cwd(), ".swarm");
  if (fs.existsSync(cwdSwarm)) return cwdSwarm;
  return path.join(process.env.HOME ?? "/tmp", ".openclaw", ".swarm");
}

const plugin = {
  id: "agent-primitives",
  name: "Agent Primitives",
  description:
    "sleep / dream / compact lifecycle tools + SwarmCompactionProvider. " +
    "Writes coordination state into a .swarm/ directory; integrates with " +
    "openclaw's compaction pipeline via registerCompactionProvider.",

  configSchema: {
    parse(raw: unknown) {
      return configSchema.parse(raw ?? {});
    },
  },

  register(api: OpenClawPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig ?? {});
    const swarmDir = resolveSwarmDir(cfg.swarmDir);
    const historyDir =
      cfg.historyDir ??
      path.join(process.env.HOME ?? "/tmp", ".openclaw", "logs", "history");

    // Register the three agent-lifecycle tools
    api.registerTool(createSleepTool({ swarmDir, resumeCommandTemplate: cfg.resumeCommandTemplate }), { name: "sleep" });
    api.registerTool(createDreamTool({ swarmDir, historyDir }), { name: "dream" });
    api.registerTool(createCompactTool({ swarmDir }), { name: "compact" });

    // Wire openclaw's compaction pipeline to use state.md as the source of truth.
    // When openclaw auto-compacts (context ceiling), our provider reads the latest
    // HANDOFF section written by the compact tool instead of running summarizeInStages().
    api.registerCompactionProvider(createSwarmCompactionProvider({ swarmDir }));

    // Trail events on compaction lifecycle
    api.on("before_compaction", () => {
      // imported lazily to avoid circular dep
      void import("./src/trail.js").then(({ appendTrailEvent }) => {
        appendTrailEvent(swarmDir, { kind: "BEFORE_COMPACTION" });
      });
    });

    api.on("after_compaction", (event: unknown) => {
      void import("./src/trail.js").then(({ appendTrailEvent }) => {
        const ev = event as { compactedCount?: number; messageCount?: number } | undefined;
        appendTrailEvent(swarmDir, {
          kind: "AFTER_COMPACTION",
          compactedCount: ev?.compactedCount ?? null,
          messageCount: ev?.messageCount ?? null,
        });
      });
    });

    api.logger.info("agent-primitives plugin loaded", {
      swarmDir,
      historyDir,
      tools: ["sleep", "dream", "compact"],
      compactionProvider: "swarm-compact (reads state.md)",
    });
  },
};

export default plugin;
