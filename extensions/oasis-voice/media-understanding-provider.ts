import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";

/**
 * Registers oasis-voice as a MediaUnderstandingProvider with `audio`
 * capability. This is what handles inbound voice MESSAGES (one .ogg /
 * .opus / .m4a blob per message) on channels like Telegram and iMessage.
 *
 * Realtime streaming STT (e.g. Twilio media-streams or future
 * Telegram Calls) goes through `RealtimeTranscriptionProvider` instead;
 * see realtime-transcription-provider.ts.
 *
 * The audio bytes are POSTed as multipart/form-data to oasis-voice's
 * `/v1/stt/transcribe` endpoint, which handles any-format input via
 * ffmpeg as of oasis-voice@436a64f (server-side change motivated by
 * this provider — see CLAW-021).
 */

const DEFAULT_ENDPOINT = "http://127.0.0.1:8731";

function resolveEndpoint(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.replace(/\/$/, "") : DEFAULT_ENDPOINT;
}

function buildAuthHeaders(apiKey: string): Record<string, string> {
  // Local lite tier doesn't require credentials. Cloud tier (CLAW-013)
  // will plumb a bearer token through `apiKey`. Empty string = no auth.
  if (!apiKey || apiKey === "anonymous") {
    return {};
  }
  return { Authorization: `Bearer ${apiKey}` };
}

export async function transcribeOasisVoiceAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const endpoint = resolveEndpoint(params.baseUrl);
  const url = `${endpoint}/v1/stt/transcribe`;

  const form = new FormData();
  // FastAPI's UploadFile reads `audio` (per oasis-voice/main.py:107).
  // Blob takes the bytes verbatim; the server uses `audio.content_type`
  // to route through the ffmpeg fallback when libsndfile can't decode.
  const blob = new Blob([params.buffer], {
    type: params.mime ?? "application/octet-stream",
  });
  form.append("audio", blob, params.fileName);

  const headers: Record<string, string> = {
    ...buildAuthHeaders(params.apiKey),
    ...(params.headers ?? {}),
  };
  // Do NOT set Content-Type ourselves — fetch + FormData generate the
  // correct multipart boundary header for us.

  const res = await fetchFn(url, {
    method: "POST",
    body: form,
    headers,
    signal: AbortSignal.timeout(params.timeoutMs),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `oasis-voice transcribe error ${res.status}: ${errText.slice(0, 240)}`,
    );
  }

  const body = (await res.json()) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text : "";
  return {
    text,
    model: params.model, // pass-through; server doesn't return a model id today
  };
}

export function buildOasisVoiceMediaUnderstandingProvider(): MediaUnderstandingProvider {
  return {
    id: "oasis-voice",
    capabilities: ["audio"],
    defaultModels: { audio: "moonshine-base" },
    // autoPriority: lower = higher preference. We're the local default; rank
    // ourselves ahead of the heavier cloud providers (deepgram/google/groq
    // sit at 20-30) so a request without an explicit provider picks us when
    // oasis-voice is reachable.
    autoPriority: { audio: 10 },
    transcribeAudio: transcribeOasisVoiceAudio,
  };
}
