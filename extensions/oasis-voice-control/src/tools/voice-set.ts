import { fetchVoices, resolveSidecar, selectableIds, type SidecarConfig } from "../sidecar.js";
import { clearVoiceChoice, readVoiceChoice, writeVoiceChoice } from "../voice-state.js";

export type VoiceSetConfig = {
  sidecar: SidecarConfig;
  configuredVoice?: string;
};

/**
 * voice_set — choose THIS bot's speaking voice.
 *
 * Scope is deliberately narrow. There is no bot parameter: a bot may only ever
 * change its own voice. Letting one bot set another's would let a compromised
 * bot impersonate a sibling in Mike's own Telegram, which is a much larger
 * capability than "pick how I sound".
 *
 * Validated against the live registry before it is written. An unvalidated write
 * would produce a bot that silently fails to speak — the failure would land at
 * synthesis time, far from the cause.
 */
export function createVoiceSetTool(config: VoiceSetConfig) {
  return {
    name: "voice_set",
    description:
      "Set your own speaking voice. Takes a voice_id from voice_list — for a multi-speaker voice " +
      "include the speaker (piper:en_GB-vctk-medium#p236). Takes effect on your next spoken reply; " +
      "no restart. Pass reset=true to go back to the voice the operator configured for you. " +
      "You can only change your OWN voice.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        voice_id: {
          type: "string",
          description: "The voice to use, exactly as voice_list reports it. Omit when reset is true.",
        },
        reset: {
          type: "boolean",
          description: "Discard your chosen voice and fall back to the operator default.",
        },
      },
    },
    async execute(_toolCallId: string, args: unknown) {
      const a = (args ?? {}) as { voice_id?: unknown; reset?: unknown };

      if (a.reset === true) {
        const had = readVoiceChoice();
        clearVoiceChoice();
        const fallback = config.configuredVoice ?? "the built-in default";
        return {
          content: [
            {
              type: "text" as const,
              text: had
                ? `Cleared your chosen voice (${had.voice_id}). You are back to ${fallback}.`
                : `You had no chosen voice. You are using ${fallback}.`,
            },
          ],
        };
      }

      const requested = typeof a.voice_id === "string" ? a.voice_id.trim() : "";
      if (!requested) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Give a voice_id, or pass reset=true. Run voice_list to see what is installed.",
            },
          ],
        };
      }

      let ids: string[];
      try {
        ids = selectableIds(await fetchVoices(config.sidecar));
      } catch (err) {
        // Refuse rather than write blind. A voice that does not resolve fails at
        // synthesis time, which is a confusing place to discover a typo.
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Could not reach the voice service at ${config.sidecar.endpoint} to check that ` +
                `voice, so nothing was changed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      if (!ids.includes(requested)) {
        const bare = requested.split("#")[0];
        const sameFamily = ids.filter((v) => v.split("#")[0] === bare);
        const hint = sameFamily.length
          ? `That voice needs a speaker. Try one of: ${sameFamily.slice(0, 8).join(", ")}`
          : `Installed voices: ${ids.length ? ids.slice(0, 12).join(", ") : "(none)"}`;
        return {
          content: [
            {
              type: "text" as const,
              text: `"${requested}" is not installed, so nothing was changed.\n${hint}`,
            },
          ],
        };
      }

      writeVoiceChoice(requested, new Date().toISOString());
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Your voice is now ${requested}. It applies to your next spoken reply — ` +
              "no restart needed. Use voice_set with reset=true to undo.",
          },
        ],
      };
    },
  };
}

export function buildVoiceSetConfig(
  cfg: { endpoint?: string; bearer_token?: string },
  configuredVoice?: string,
): VoiceSetConfig {
  return { sidecar: resolveSidecar(cfg), configuredVoice };
}
