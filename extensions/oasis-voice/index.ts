import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildOasisVoiceMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildOasisVoiceRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import { buildOasisVoiceSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "oasis-voice",
  name: "Oasis Voice",
  description:
    "TTS + STT via oasis-voice sidecar (Piper + Moonshine lite tier locally; GPU tiers via hosted endpoint). Registers three provider capabilities: SpeechProvider (outbound TTS), MediaUnderstandingProvider with audio capability (inbound voice messages — Telegram/iMessage), and RealtimeTranscriptionProvider (streaming STT for telephony / WebRTC).",
  register(api) {
    api.registerSpeechProvider(buildOasisVoiceSpeechProvider());
    api.registerMediaUnderstandingProvider(buildOasisVoiceMediaUnderstandingProvider());
    api.registerRealtimeTranscriptionProvider(buildOasisVoiceRealtimeTranscriptionProvider());
  },
});
