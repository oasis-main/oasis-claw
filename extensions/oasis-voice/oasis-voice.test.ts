import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildOasisVoiceMediaUnderstandingProvider,
  transcribeOasisVoiceAudio,
} from "./media-understanding-provider.js";
import { buildOasisVoiceSpeechProvider } from "./speech-provider.js";
import { buildOasisVoiceRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

// ---------------------------------------------------------------------------
// Speech provider
// ---------------------------------------------------------------------------

describe("buildOasisVoiceSpeechProvider", () => {
  const provider = buildOasisVoiceSpeechProvider();

  it("has correct id and label", () => {
    expect(provider.id).toBe("oasis-voice");
    expect(provider.label).toBe("Oasis Voice");
  });

  it("isConfigured is always true (no required credentials)", () => {
    expect(
      provider.isConfigured({
        providerConfig: {},
      }),
    ).toBe(true);

    expect(
      provider.isConfigured({
        providerConfig: { endpoint: "http://some-server:8731" },
      }),
    ).toBe(true);
  });

  it("synthesize calls /v1/tts/speak and returns WAV buffer", async () => {
    const fakeWav = Buffer.from("RIFF...fake-wav-data");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => fakeWav.buffer as ArrayBuffer,
    } as Response);

    const result = await provider.synthesize({
      text: "hello world",
      providerConfig: { endpoint: "http://127.0.0.1:8731" },
      target: "audio-file",
      timeoutMs: 5000,
      cfg: {} as never,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/tts/speak");
    expect(JSON.parse(init.body as string)).toMatchObject({ text: "hello world" });

    expect(result.outputFormat).toBe("wav");
    expect(result.fileExtension).toBe(".wav");
    expect(result.audioBuffer).toBeInstanceOf(Buffer);
    // audio-file target must NOT request opus — that's a Telegram-style
    // voice-note thing. WAV is the cheaper, more compatible default.
    expect(url).not.toContain("format=opus");

    fetchSpy.mockRestore();
  });

  it("synthesize requests opus + reports voice-compatible when target=voice-note", async () => {
    const fakeOpus = Buffer.from("OggS\x00fake-opus-data");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => fakeOpus.buffer as ArrayBuffer,
    } as Response);

    const result = await provider.synthesize({
      text: "hello from telegram",
      providerConfig: { endpoint: "http://oasis-voice:8731" },
      target: "voice-note",
      timeoutMs: 5000,
      cfg: {} as never,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    // Must hit /v1/tts/speak WITH ?format=opus so oasis-voice does the
    // WAV→opus transcode server-side. Telegram sendVoice rejects WAV.
    expect(url).toContain("/v1/tts/speak");
    expect(url).toContain("format=opus");

    expect(result.outputFormat).toBe("opus");
    expect(result.fileExtension).toBe(".ogg");
    expect(result.voiceCompatible).toBe(true);
    expect(result.audioBuffer).toBeInstanceOf(Buffer);

    fetchSpy.mockRestore();
  });

  it("synthesize includes bearer Authorization header when configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as Response);

    await provider.synthesize({
      text: "hi",
      providerConfig: { endpoint: "http://cloud:8731", bearer_token: "tok123" },
      target: "audio-file",
      timeoutMs: 5000,
      cfg: {} as never,
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok123");
    fetchSpy.mockRestore();
  });

  it("synthesize throws on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    } as Response);

    await expect(
      provider.synthesize({
        text: "hi",
        providerConfig: {},
        target: "audio-file",
        timeoutMs: 5000,
        cfg: {} as never,
      }),
    ).rejects.toThrow("oasis-voice TTS error 503");
  });

  it("synthesizeTelephony encodes PCM as mulaw at 8 kHz", async () => {
    // 44-byte WAV header + 4 bytes of PCM16 silence (0x00 0x00 0x00 0x00)
    const wavHeader = Buffer.alloc(44, 0);
    const pcmSamples = Buffer.alloc(4, 0); // 2 silent int16 samples
    const fakeWav = Buffer.concat([wavHeader, pcmSamples]);
    // Use a clean ArrayBuffer that exactly matches the buffer contents
    const fakeWavAb = fakeWav.buffer.slice(fakeWav.byteOffset, fakeWav.byteOffset + fakeWav.byteLength);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => fakeWavAb as ArrayBuffer,
    } as Response);

    const result = await provider.synthesizeTelephony!({
      text: "hi",
      providerConfig: {},
      timeoutMs: 5000,
      cfg: {} as never,
    });

    expect(result.outputFormat).toBe("mulaw");
    expect(result.sampleRate).toBe(8000);
    // 4 bytes PCM16 → 2 µ-law bytes
    expect(result.audioBuffer.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Realtime transcription provider
// ---------------------------------------------------------------------------

describe("buildOasisVoiceRealtimeTranscriptionProvider", () => {
  const provider = buildOasisVoiceRealtimeTranscriptionProvider();

  it("has correct id and label", () => {
    expect(provider.id).toBe("oasis-voice");
    expect(provider.label).toBe("Oasis Voice Realtime STT");
  });

  it("isConfigured is always true", () => {
    expect(provider.isConfigured({ providerConfig: {} })).toBe(true);
  });

  it("createSession returns a RealtimeTranscriptionSession shape", () => {
    const session = provider.createSession({
      providerConfig: { endpoint: "http://127.0.0.1:8731" },
    });
    expect(typeof session.connect).toBe("function");
    expect(typeof session.sendAudio).toBe("function");
    expect(typeof session.close).toBe("function");
    expect(typeof session.isConnected).toBe("function");
  });

  it("isConnected returns false before connect()", () => {
    const session = provider.createSession({ providerConfig: {} });
    expect(session.isConnected()).toBe(false);
  });

  it("queues audio when not yet connected and drains on open", async () => {
    const sentChunks: Uint8Array[] = [];
    const mockWs = {
      onopen: null as (() => void) | null,
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      onerror: null as ((ev: unknown) => void) | null,
      onclose: null as (() => void) | null,
      send(data: Uint8Array) {
        sentChunks.push(data);
      },
      close() {},
    };
    vi.stubGlobal("WebSocket", function () {
      return mockWs;
    });

    const session = provider.createSession({ providerConfig: {} });
    const chunk = Buffer.from([0x01, 0x02]);
    session.sendAudio(chunk); // queued – not connected yet

    await session.connect();
    // Trigger the ws.onopen callback
    mockWs.onopen?.();

    expect(sentChunks.length).toBe(1);
    expect(sentChunks[0]).toEqual(chunk);

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// Media understanding provider (inbound voice messages — Telegram, iMessage)
// ---------------------------------------------------------------------------

describe("buildOasisVoiceMediaUnderstandingProvider", () => {
  const provider = buildOasisVoiceMediaUnderstandingProvider();

  it("declares the audio capability and oasis-voice id", () => {
    expect(provider.id).toBe("oasis-voice");
    expect(provider.capabilities).toEqual(["audio"]);
    expect(provider.defaultModels?.audio).toBe("moonshine-base");
  });

  it("ranks itself ahead of the cloud providers via autoPriority", () => {
    // Lower priority = preferred. We're at 10; deepgram/google/groq are 20-30.
    expect(provider.autoPriority?.audio).toBeLessThan(20);
  });

  it("registers a transcribeAudio handler", () => {
    expect(typeof provider.transcribeAudio).toBe("function");
  });
});

describe("transcribeOasisVoiceAudio", () => {
  function makeRequest(
    overrides: Partial<Parameters<typeof transcribeOasisVoiceAudio>[0]> = {},
  ): Parameters<typeof transcribeOasisVoiceAudio>[0] {
    return {
      buffer: Buffer.from([0xff, 0xfe, 0xfd]),
      fileName: "voice.ogg",
      mime: "audio/ogg",
      apiKey: "",
      timeoutMs: 5000,
      ...overrides,
    } as Parameters<typeof transcribeOasisVoiceAudio>[0];
  }

  it("POSTs multipart/form-data to /v1/stt/transcribe and returns the text", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ text: "hello nimbus" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await transcribeOasisVoiceAudio(
      makeRequest({ fetchFn: fetchSpy as unknown as typeof fetch }),
    );

    expect(result.text).toBe("hello nimbus");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8731/v1/stt/transcribe");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    // We MUST NOT set Content-Type ourselves — fetch derives the boundary.
    const hdrs = (init.headers ?? {}) as Record<string, string>;
    expect(hdrs["Content-Type"]).toBeUndefined();
    expect(hdrs["content-type"]).toBeUndefined();
  });

  it("uses baseUrl when provided (cloud-tier hop)", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ text: "" }), { status: 200 }),
    );
    await transcribeOasisVoiceAudio(
      makeRequest({
        baseUrl: "https://voice.oasis-cloud.example",
        fetchFn: fetchSpy as unknown as typeof fetch,
      }),
    );
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe("https://voice.oasis-cloud.example/v1/stt/transcribe");
  });

  it("strips a trailing slash on baseUrl", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ text: "" }), { status: 200 }),
    );
    await transcribeOasisVoiceAudio(
      makeRequest({
        baseUrl: "https://voice.oasis-cloud.example/",
        fetchFn: fetchSpy as unknown as typeof fetch,
      }),
    );
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe("https://voice.oasis-cloud.example/v1/stt/transcribe");
  });

  it("sends Authorization: Bearer when apiKey is non-empty", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ text: "" }), { status: 200 }),
    );
    await transcribeOasisVoiceAudio(
      makeRequest({
        apiKey: "sk-cloud-token",
        fetchFn: fetchSpy as unknown as typeof fetch,
      }),
    );
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const hdrs = (init.headers ?? {}) as Record<string, string>;
    expect(hdrs.Authorization).toBe("Bearer sk-cloud-token");
  });

  it("omits Authorization when apiKey is empty (local lite tier)", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ text: "" }), { status: 200 }),
    );
    await transcribeOasisVoiceAudio(
      makeRequest({ apiKey: "", fetchFn: fetchSpy as unknown as typeof fetch }),
    );
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const hdrs = (init.headers ?? {}) as Record<string, string>;
    expect(hdrs.Authorization).toBeUndefined();
  });

  it("throws with status + body excerpt on non-OK response", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response("unsupported audio format: garbage", {
        status: 415,
      }),
    );
    await expect(
      transcribeOasisVoiceAudio(
        makeRequest({ fetchFn: fetchSpy as unknown as typeof fetch }),
      ),
    ).rejects.toThrow(/415.*unsupported audio format/);
  });

  it("treats missing text field as empty transcript", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const result = await transcribeOasisVoiceAudio(
      makeRequest({ fetchFn: fetchSpy as unknown as typeof fetch }),
    );
    expect(result.text).toBe("");
  });
});
