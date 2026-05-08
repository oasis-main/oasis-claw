import { describe, expect, it, vi, beforeEach } from "vitest";
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
