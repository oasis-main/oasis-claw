import type {
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
  SpeechSynthesisStreamRequest,
  SpeechSynthesisStreamResult,
  SpeechTelephonySynthesisRequest,
  SpeechTelephonySynthesisResult,
} from "openclaw/plugin-sdk/speech";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8731";
const DEFAULT_VOICE = "piper:en_US-lessac-high";

// Piper's lite-tier output is 22050 Hz int16 WAV.
// Twilio Media Streams expect 8000 Hz µ-law (mulaw).  We ask oasis-voice
// /v1/tts/speak for raw PCM at 8000 Hz then encode to mulaw here so the
// telephony path stays dependency-free on the openclaw side.
const TELEPHONY_SAMPLE_RATE = 8_000;

function getEndpoint(providerConfig: Record<string, unknown>): string {
  const raw = providerConfig["endpoint"];
  return typeof raw === "string" && raw.length > 0 ? raw : DEFAULT_ENDPOINT;
}

function getVoice(providerConfig: Record<string, unknown>): string {
  const raw = providerConfig["tts_voice"];
  return typeof raw === "string" && raw.length > 0 ? raw : DEFAULT_VOICE;
}

function getBearer(providerConfig: Record<string, unknown>): string | undefined {
  const raw = providerConfig["bearer_token"];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function buildHeaders(bearer?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer) {
    headers["Authorization"] = `Bearer ${bearer}`;
  }
  return headers;
}

// Linear PCM16 (int16 LE, mono) → µ-law encoding per ITU-T G.711.
// Only used for the telephony path (8 kHz, 1 channel).
function pcm16ToMulaw(pcm: Buffer): Buffer {
  const out = Buffer.allocUnsafe(pcm.length / 2);
  for (let i = 0; i < out.length; i++) {
    let sample = pcm.readInt16LE(i * 2);
    const sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    sample += 33; // bias
    if (sample > 32767) sample = 32767;
    let exponent = 7;
    for (let exp = 0x4000; (sample & exp) === 0 && exponent > 0; exp >>= 1) exponent--;
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

export function buildOasisVoiceSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "oasis-voice",
    label: "Oasis Voice",
    aliases: ["oasis-ai-tts", "piper"],
    autoSelectOrder: 5,

    isConfigured: ({ providerConfig }) => {
      // Always available — lite tier needs no credentials; cloud tier uses
      // bearer_token which is optional (handled gracefully below).
      return typeof getEndpoint(providerConfig) === "string";
    },

    synthesize: async (req: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> => {
      const endpoint = getEndpoint(req.providerConfig);
      const voice = getVoice(req.providerConfig);
      const bearer = getBearer(req.providerConfig);

      const res = await fetch(`${endpoint}/v1/tts/speak`, {
        method: "POST",
        headers: buildHeaders(bearer),
        body: JSON.stringify({ text: req.text, voice }),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`oasis-voice TTS error ${res.status}: ${await res.text()}`);
      }
      const audioBuffer = Buffer.from(await res.arrayBuffer());
      return {
        audioBuffer,
        outputFormat: "wav",
        fileExtension: ".wav",
        voiceCompatible: req.target === "voice-note",
      };
    },

    streamSynthesize: async (
      req: SpeechSynthesisStreamRequest,
    ): Promise<SpeechSynthesisStreamResult> => {
      const endpoint = getEndpoint(req.providerConfig);
      const voice = getVoice(req.providerConfig);
      const bearer = getBearer(req.providerConfig);

      const wsUrl = endpoint.replace(/^http/, "ws") + "/v1/tts/stream";
      const ws = new WebSocket(wsUrl, {
        headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined,
      } as ConstructorParameters<typeof WebSocket>[1]);

      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      let headerReceived = false;

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ text: req.text, voice }));
          resolve();
        };
        ws.onerror = (ev) => reject(new Error(`oasis-voice WS error: ${String(ev)}`));
      });

      ws.onmessage = (ev) => {
        if (!headerReceived && typeof ev.data === "string") {
          headerReceived = true; // first message is JSON header
          return;
        }
        if (ev.data instanceof ArrayBuffer) {
          writer.write(new Uint8Array(ev.data)).catch(() => {});
        } else if (typeof ev.data === "string") {
          // boundary marker or done — ignore
        }
      };
      ws.onclose = () => writer.close().catch(() => {});
      ws.onerror = (ev) => writer.abort(new Error(`oasis-voice WS error: ${String(ev)}`)).catch(() => {});

      return {
        audioStream: readable,
        outputFormat: "pcm16",
        fileExtension: ".wav",
        voiceCompatible: req.target === "voice-note",
        release: async () => {
          try {
            ws.close();
          } catch {
            // ignore
          }
        },
      };
    },

    synthesizeTelephony: async (
      req: SpeechTelephonySynthesisRequest,
    ): Promise<SpeechTelephonySynthesisResult> => {
      const endpoint = getEndpoint(req.providerConfig);
      const voice = getVoice(req.providerConfig);
      const bearer = getBearer(req.providerConfig);

      // Request raw int16 PCM at 8 kHz by appending query params.
      // oasis-voice /v1/tts/speak returns WAV; we strip the 44-byte header.
      const url = new URL(`${endpoint}/v1/tts/speak`);
      url.searchParams.set("sample_rate", String(TELEPHONY_SAMPLE_RATE));
      url.searchParams.set("channels", "1");

      const res = await fetch(url.toString(), {
        method: "POST",
        headers: buildHeaders(bearer),
        body: JSON.stringify({ text: req.text, voice }),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`oasis-voice telephony TTS error ${res.status}: ${await res.text()}`);
      }
      const wavBuffer = Buffer.from(await res.arrayBuffer());

      // Strip the WAV header (44 bytes for standard PCM WAV) to get raw PCM16.
      const WAV_HEADER_BYTES = 44;
      const pcm16 = wavBuffer.subarray(WAV_HEADER_BYTES);
      const audioBuffer = pcm16ToMulaw(pcm16);

      return {
        audioBuffer,
        outputFormat: "mulaw",
        sampleRate: TELEPHONY_SAMPLE_RATE,
      };
    },
  };
}
