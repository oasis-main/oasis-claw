import { fetchVoices, resolveSidecar, selectableIds, type SidecarConfig } from "../sidecar.js";
import { readVoiceChoice } from "../voice-state.js";

export type VoiceListConfig = {
  sidecar: SidecarConfig;
  configuredVoice?: string;
};

/**
 * voice_list — read-only. Shows which voices this bot can speak with, and which
 * one it is using right now.
 *
 * Reports the SOURCE of the current voice as well as its id. A bot (or Mike
 * reading over its shoulder) should never have to guess why it sounds the way it
 * does — the same reasoning behind logging the image route at boot.
 */
export function createVoiceListTool(config: VoiceListConfig) {
  return {
    name: "voice_list",
    description:
      "List the speaking voices installed for you, and show which one you are using now. " +
      "Read-only and cheap. Multi-speaker voices are listed as one entry per selectable speaker " +
      "(for example piper:en_GB-vctk-medium#p236). Use voice_set to change your voice.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute() {
      let voices;
      try {
        voices = await fetchVoices(config.sidecar);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Could not reach the voice service at ${config.sidecar.endpoint}: ` +
                `${err instanceof Error ? err.message : String(err)}\n` +
                "Your current voice is unaffected. Try again, and tell Mike if it keeps failing.",
            },
          ],
        };
      }

      const ids = selectableIds(voices);
      const chosen = readVoiceChoice();
      const current = chosen?.voice_id ?? config.configuredVoice;
      const source = chosen
        ? `your own choice, set ${chosen.chosen_at}`
        : config.configuredVoice
          ? "the operator default for this bot"
          : "the built-in default";

      const lines = [
        `Current voice: ${current ?? "(unset)"}`,
        `  source: ${source}`,
        "",
        `Installed voices (${ids.length}):`,
        ...(ids.length ? ids.map((v) => `  ${v}`) : ["  (none found — no voices are installed)"]),
      ];

      if (voices.cloned.length > 0) {
        lines.push("", `Of those, ${voices.cloned.length} are cloned voices.`);
      }
      if (voices.supports_cloning === false) {
        lines.push(
          "",
          "Voice cloning is not available on this backend, so the list above is fixed.",
        );
      }
      lines.push("", "To change: voice_set {\"voice_id\": \"<one of the ids above>\"}");

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  };
}

export function buildVoiceListConfig(
  cfg: { endpoint?: string; bearer_token?: string },
  configuredVoice?: string,
): VoiceListConfig {
  return { sidecar: resolveSidecar(cfg), configuredVoice };
}
