import fs from "node:fs";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { z } from "zod";
import { createCompactTool } from "./src/tools/compact.js";
import { createDreamTool } from "./src/tools/dream.js";
import { createSleepTool } from "./src/tools/sleep.js";

const configSchema = z.object({
  swarmDir: z.string().optional(),
  historyDir: z.string().optional(),
});

export type AgentPrimitivesConfig = z.infer<typeof configSchema>;

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
  id: "agent-primitives",
  name: "Agent Primitives",
  description:
    "sleep / dream / compact lifecycle tools. Stubs that do the FS-side work; full host integration tracks under oasis-x ORG-050.",

  configSchema: {
    parse(raw: unknown) {
      return configSchema.parse(raw ?? {});
    },
  },

  register(api: OpenClawPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig ?? {});
    const swarmDir = resolveSwarmDir(cfg.swarmDir);
    const historyDir =
      cfg.historyDir ?? path.join(process.env.HOME ?? "/tmp", ".openclaw", "logs", "history");

    api.registerTool(createSleepTool({ swarmDir }), { name: "sleep" });
    api.registerTool(createDreamTool({ swarmDir, historyDir }), { name: "dream" });
    api.registerTool(createCompactTool({ swarmDir }), { name: "compact" });

    api.logger.info("agent-primitives plugin loaded", {
      swarmDir,
      historyDir,
      tools: ["sleep", "dream", "compact"],
      hostIntegrationStatus: "stub — see ORG-050 for scheduler/restart wiring",
    });
  },
};

export default plugin;
