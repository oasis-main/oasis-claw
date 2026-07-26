import type { EmbeddingInput } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";

const DEFAULT_ENDPOINT = "http://oasis-semantics:8732";
const DEFAULT_TIMEOUT_MS = 60_000;

export type OasisSemanticsClientConfig = {
  endpoint?: string;
  bearerToken?: string;
  requestTimeoutMs?: number;
};

type TextEmbedResponse = {
  model: string;
  embeddings: number[][];
};

type MultimodalInput =
  | { text: string }
  | { image_bytes: string }
  | { image_url: string };

type MultimodalEmbedResponse = {
  model: string;
  embeddings: number[][];
  dim: number;
};

export class OasisSemanticsClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(config: OasisSemanticsClientConfig = {}) {
    this.baseUrl = (config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
    this.headers = { "Content-Type": "application/json" };
    if (config.bearerToken) {
      this.headers["Authorization"] = `Bearer ${config.bearerToken}`;
    }
    this.timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async embedText(texts: string[], model: string): Promise<number[][]> {
    const body = JSON.stringify({ model, input: texts });
    const res = await this.post("/api/embed", body);
    const data = (await res.json()) as TextEmbedResponse;
    return data.embeddings;
  }

  async embedMultimodal(
    inputs: MultimodalInput[],
    model: string,
  ): Promise<number[][]> {
    const body = JSON.stringify({ model, inputs });
    const res = await this.post("/v1/embed/multimodal", body);
    const data = (await res.json()) as MultimodalEmbedResponse;
    return data.embeddings;
  }

  async healthz(): Promise<boolean> {
    try {
      const res = await this.post("/healthz", "", "GET");
      return res.ok;
    } catch {
      return false;
    }
  }

  private async post(
    path: string,
    body: string,
    method: string = "POST",
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: this.headers,
        body: method === "GET" ? undefined : body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `oasis-semantics ${method} ${path} returned ${res.status}: ${text}`,
        );
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function embeddingInputToMultimodalPayload(
  input: EmbeddingInput,
): MultimodalInput[] {
  const items: MultimodalInput[] = [];
  if (!input.parts?.length) {
    items.push({ text: input.text });
    return items;
  }
  for (const part of input.parts) {
    if (part.type === "text") {
      items.push({ text: part.text });
    } else if (part.type === "inline-data") {
      items.push({ image_bytes: part.data });
    }
  }
  if (items.length === 0) {
    items.push({ text: input.text });
  }
  return items;
}
