import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { buildOasisVoiceMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildOasisVoiceRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import { buildOasisVoiceSpeechProvider } from "./speech-provider.js";

const TTS_INPUT_RULES: string[] = [
  "## Voice output (oasis-voice TTS)",
  "",
  "When your reply will be synthesised to audio by oasis-voice — i.e. the channel is a Telegram voice note, a Twilio telephony leg, or any other path that ends in `/v1/tts/speak` — strip emojis from the text before you send it. Piper reads emoji aloud as their literal Unicode name (e.g. \"face with tears of joy\"), which is jarring and unprofessional in audio. Punctuation, em-dashes and ellipses are fine — they map to natural prosody.",
  "",
  "Narrow exception: keep the emoji only if the *audible pronunciation itself* is the joke — a deliberately ironic or deadpan bit where reading the Unicode name aloud is the point. If you have to think about whether it qualifies, it doesn't; strip it.",
  "",
  "This rule applies to TTS-bound output only. Text-only channels (chat UI, Telegram text messages, email) follow the user's normal emoji preference and are not affected.",
];

// IMPORTANT: do NOT import `definePluginEntry` from "openclaw/plugin-sdk/plugin-entry".
// That subpath is a runtime import; the gateway's plugin loader silently
// skips the plugin when it can't resolve `openclaw/*` at load time (no
// node_modules under /app/extensions/<id>/ in the runtime image). All other
// extensions use a type-only import + plain default export — we match that
// pattern so this plugin actually shows up in the gateway's startup tally
// and reaches registerSpeechProvider / registerMediaUnderstandingProvider /
// registerRealtimeTranscriptionProvider.
const plugin = {
  id: "oasis-voice",
  name: "Oasis Voice",
  description:
    "TTS + STT via oasis-voice sidecar (Piper + Moonshine lite tier locally; GPU tiers via hosted endpoint). Registers three provider capabilities: SpeechProvider (outbound TTS), MediaUnderstandingProvider with audio capability (inbound voice messages — Telegram/iMessage), and RealtimeTranscriptionProvider (streaming STT for telephony / WebRTC).",
  register(api: OpenClawPluginApi) {
    api.logger.info("oasis-voice plugin loaded", {
      pluginConfig: api.pluginConfig,
    });
    api.registerSpeechProvider(buildOasisVoiceSpeechProvider());
    api.registerMediaUnderstandingProvider(buildOasisVoiceMediaUnderstandingProvider());
    api.registerRealtimeTranscriptionProvider(buildOasisVoiceRealtimeTranscriptionProvider());

    // Behavioural rule injected into every agent's memory prompt while this
    // plugin is loaded. Piper reads emoji aloud as their literal Unicode
    // name ("face with tears of joy"), which is jarring in audio. We want
    // the model to strip emojis from anything destined for TTS — but only
    // for TTS-bound output, not for text replies in the same conversation.
    api.registerMemoryPromptSupplement(() => TTS_INPUT_RULES);
  },
};

export default plugin;
