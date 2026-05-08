import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildOasisVoiceRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import { buildOasisVoiceSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "oasis-voice",
  name: "Oasis Voice",
  description: "TTS + streaming STT via oasis-voice sidecar (Piper + Moonshine lite tier; GPU tiers on hosted endpoint)",
  register(api) {
    api.registerSpeechProvider(buildOasisVoiceSpeechProvider());
    api.registerRealtimeTranscriptionProvider(buildOasisVoiceRealtimeTranscriptionProvider());
  },
});
