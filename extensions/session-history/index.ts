import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { z } from "zod";
import { registerHistoryLogger } from "./src/history-logger.js";

const configSchema = z.object({
  logDir: z.string().optional(),
});

export type SessionHistoryConfig = z.infer<typeof configSchema>;

const plugin = {
  id: "session-history",
  name: "Session History",
  description:
    "Append-only JSONL session transcripts. Hooks llm_input, llm_output, and tool_call events.",

  configSchema: {
    parse(raw: unknown) {
      return configSchema.parse(raw ?? {});
    },
  },

  register(api: OpenClawPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig ?? {});
    const stateDir = api.runtime?.stateDir ?? (process.env.HOME + "/.openclaw");
    const logDir = cfg.logDir ?? `${stateDir}/logs/history`;

    // Append-only JSONL transcripts of every llm_input, llm_output, and
    // tool_call event. The sandbox-isolation test suite verifies the writer
    // never escapes the configured logDir even under adversarial inputs.
    registerHistoryLogger(api, { logDir });

    api.logger.info("session-history plugin loaded", { logDir });
  },
};

export default plugin;
