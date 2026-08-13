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

export type RerankResult = {
  /** Index into the documents array that was SENT, not into the response. */
  index: number;
  /** 0..1 relevance (the cross-encoder applies Sigmoid). See rerank(). */
  relevance_score: number;
  document?: string | null;
};

type RerankResponse = {
  model: string;
  results: RerankResult[];
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

  /**
   * Reorder `documents` by relevance to `query`, best first.
   *
   * SECOND stage of retrieval, never the first. The embedding tiers decide
   * which candidates exist; this decides their order. A document the retrieval
   * stage did not return cannot be recovered here — so a reranker raises
   * PRECISION on a corpus, and can never extend one.
   *
   * Scores are 0..1 (the cross-encoder applies Sigmoid). Measured on the
   * bge-base tier: 0.9998 for an obviously-correct pair, 0.0 for an unrelated
   * one, so a threshold is usable — but calibrate it per corpus rather than
   * assuming 0.5, and prefer the ORDER over the number when comparing across
   * different queries.
   *
   * Feed it prose. The model is trained on natural-language question/passage
   * pairs and scores bare code signatures near zero even when it ranks them
   * correctly, so send docstrings and summaries rather than raw signatures.
   */
  async rerank(
    query: string,
    documents: string[],
    opts: { model?: string; topN?: number; returnDocuments?: boolean } = {},
  ): Promise<RerankResult[]> {
    if (documents.length === 0) return [];
    const body = JSON.stringify({
      query,
      documents,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.topN ? { top_n: opts.topN } : {}),
      ...(opts.returnDocuments ? { return_documents: true } : {}),
    });
    const res = await this.post("/v1/rerank", body);
    const data = (await res.json()) as RerankResponse;
    return data.results;
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
