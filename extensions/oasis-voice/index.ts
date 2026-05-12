import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { buildOasisVoiceMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildOasisVoiceRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import { buildOasisVoiceSpeechProvider } from "./speech-provider.js";

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
  },
};

export default plugin;
