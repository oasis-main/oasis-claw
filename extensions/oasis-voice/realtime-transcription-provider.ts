import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8731";
const RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_ATTEMPTS = 5;

function getEndpoint(providerConfig: Record<string, unknown>): string {
  const raw = providerConfig["endpoint"];
  return typeof raw === "string" && raw.length > 0 ? raw : DEFAULT_ENDPOINT;
}

function getBearer(providerConfig: Record<string, unknown>): string | undefined {
  const raw = providerConfig["bearer_token"];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

type OasisVoiceTranscriptChunk = {
  type: "partial" | "final";
  text: string;
};

function createOasisVoiceRealtimeSession(
  req: RealtimeTranscriptionSessionCreateRequest & {
    wsUrl: string;
    bearer: string | undefined;
  },
): RealtimeTranscriptionSession {
  let ws: WebSocket | null = null;
  let connected = false;
  let closed = false;
  let reconnectAttempts = 0;
  const audioQueue: Buffer[] = [];

  function connect() {
    if (closed) return;
    const wsInstance = new WebSocket(
      req.wsUrl,
      req.bearer
        ? ({ headers: { Authorization: `Bearer ${req.bearer}` } } as ConstructorParameters<typeof WebSocket>[1])
        : undefined,
    );
    ws = wsInstance;

    wsInstance.onopen = () => {
      connected = true;
      reconnectAttempts = 0;
      req.onSpeechStart?.();
      // Drain queued audio
      for (const chunk of audioQueue) {
        wsInstance.send(chunk);
      }
      audioQueue.length = 0;
    };

    wsInstance.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const msg = JSON.parse(ev.data) as OasisVoiceTranscriptChunk;
        if (msg.type === "partial" && msg.text) {
          req.onPartial?.(msg.text);
        } else if (msg.type === "final" && msg.text) {
          req.onTranscript?.(msg.text);
        }
      } catch {
        // ignore malformed messages
      }
    };

    wsInstance.onerror = () => {
      req.onError?.(new Error("oasis-voice STT WebSocket error"));
    };

    wsInstance.onclose = () => {
      connected = false;
      ws = null;
      if (!closed && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        setTimeout(connect, RECONNECT_DELAY_MS);
      }
    };
  }

  return {
    async connect() {
      connect();
    },

    sendAudio(audio: Buffer) {
      if (ws && connected) {
        ws.send(audio);
      } else {
        audioQueue.push(audio);
      }
    },

    close() {
      closed = true;
      try {
        ws?.close();
      } catch {
        // ignore
      }
      ws = null;
    },

    isConnected() {
      return connected && ws !== null;
    },
  };
}

export function buildOasisVoiceRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin {
  return {
    id: "oasis-voice",
    label: "Oasis Voice Realtime STT",
    aliases: ["oasis-ai-stt", "moonshine"],
    autoSelectOrder: 5,

    isConfigured: ({ providerConfig }) => {
      return typeof getEndpoint(providerConfig) === "string";
    },

    createSession: (req: RealtimeTranscriptionSessionCreateRequest) => {
      const endpoint = getEndpoint(req.providerConfig);
      const bearer = getBearer(req.providerConfig);
      const wsUrl = endpoint.replace(/^http/, "ws") + "/v1/stt/stream";
      return createOasisVoiceRealtimeSession({ ...req, wsUrl, bearer });
    },
  };
}
