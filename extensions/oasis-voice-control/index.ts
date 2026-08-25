import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { z } from "zod";
import { buildVoiceListConfig, createVoiceListTool } from "./src/tools/voice-list.js";
import { buildVoiceSetConfig, createVoiceSetTool } from "./src/tools/voice-set.js";
import { readVoiceChoice } from "./src/voice-state.js";

// Must mirror openclaw.plugin.json configSchema field-for-field. A mismatch
// here crash-loops the whole fleet at boot — not hypothetical, it happened on
// 2026-07-30 when oasis-reach's manifest omitted `enabled`.
const configSchema = z.object({
  enabled: z.boolean().optional(),
  endpoint: z.string().optional(),
  bearer_token: z.string().optional(),
});

const plugin = {
  id: "oasis-voice-control",
  name: "Oasis Voice Control",
  description:
    "Self-service voice selection: voice_list shows the installed voices and the one in use, " +
    "voice_set changes this bot's own voice with no restart.",

  configSchema: {
    parse(raw: unknown) {
      return configSchema.parse(raw ?? {});
    },
  },

  register(api: OpenClawPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig ?? {});

    // Gate on ENV, not cfg.enabled. The agent tool set is resolved in a FRESH
    // plugin-load context that does NOT thread plugins.entries.<id>.config, so
    // a cfg-only gate leaves the tools registered but unusable (CLAW-076).
    if (process.env.OASIS_VOICE_CONTROL_DISABLE === "1") {
      api.logger.info("oasis-voice-control DISABLED (OASIS_VOICE_CONTROL_DISABLE=1)");
      return;
    }

    // The operator default, for reporting "why do I sound like this". This is
    // the same variable the entrypoint writes into messages.tts.providers.
    const configuredVoice = (process.env.OASIS_VOICE_TTS_VOICE || "").trim() || undefined;

    api.registerTool(createVoiceListTool(buildVoiceListConfig(cfg, configuredVoice)), {
      name: "voice_list",
    });
    api.registerTool(createVoiceSetTool(buildVoiceSetConfig(cfg, configuredVoice)), {
      name: "voice_set",
    });

    const chosen = readVoiceChoice();
    api.logger.info("oasis-voice-control plugin loaded", {
      // Which source is currently winning. Logged at boot so a surprising voice
      // is never a mystery — the same reasoning as the image-route boot line.
      voiceSource: chosen ? "bot-chosen" : configuredVoice ? "operator-default" : "built-in-default",
      voice: chosen?.voice_id ?? configuredVoice ?? "(built-in)",
    });
  },
};

export default plugin;
