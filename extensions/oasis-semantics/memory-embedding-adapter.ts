import type {
  EmbeddingInput,
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCreateOptions,
  MemoryEmbeddingProviderCreateResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  OasisSemanticsClient,
  embeddingInputToMultimodalPayload,
  type OasisSemanticsClientConfig,
} from "./embedding-client.js";

const MULTIMODAL_MODELS = new Set(["clip-lite", "siglip"]);

const DEFAULT_TEXT_MODEL = "default";
const DEFAULT_MM_MODEL = "clip-lite";

export function buildOasisSemanticsAdapter(
  pluginConfig: Record<string, unknown>,
): MemoryEmbeddingProviderAdapter {
  const clientConfig: OasisSemanticsClientConfig = {
    endpoint: (pluginConfig.endpoint as string) ?? undefined,
    bearerToken: (pluginConfig.bearer_token as string) ?? undefined,
    requestTimeoutMs: (pluginConfig.request_timeout_ms as number) ?? undefined,
  };
  const defaultTextModel =
    (pluginConfig.default_text_model as string) ?? DEFAULT_TEXT_MODEL;
  const defaultMmModel =
    (pluginConfig.default_mm_model as string) ?? DEFAULT_MM_MODEL;

  return {
    id: "oasis-semantics",
    defaultModel: defaultTextModel,
    transport: "remote",

    supportsMultimodalEmbeddings: ({ model }) => {
      return MULTIMODAL_MODELS.has(model) || MULTIMODAL_MODELS.has(model.toLowerCase());
    },

    create: async (
      options: MemoryEmbeddingProviderCreateOptions,
    ): Promise<MemoryEmbeddingProviderCreateResult> => {
      const resolvedModel = options.model || defaultTextModel;
      const client = new OasisSemanticsClient(clientConfig);

      const provider: MemoryEmbeddingProvider = {
        id: "oasis-semantics",
        model: resolvedModel,

        embedQuery: async (text: string): Promise<number[]> => {
          const results = await client.embedText([text], resolvedModel);
          return results[0]!;
        },

        embedBatch: async (texts: string[]): Promise<number[][]> => {
          if (texts.length === 0) return [];
          return client.embedText(texts, resolvedModel);
        },

        embedBatchInputs: async (
          inputs: EmbeddingInput[],
        ): Promise<number[][]> => {
          if (inputs.length === 0) return [];

          const hasMultimodal = inputs.some(
            (input) =>
              input.parts?.some((p) => p.type === "inline-data") ?? false,
          );

          if (!hasMultimodal) {
            return client.embedText(
              inputs.map((i) => i.text),
              resolvedModel,
            );
          }

          const mmModel = MULTIMODAL_MODELS.has(resolvedModel)
            ? resolvedModel
            : defaultMmModel;

          const allItems: { inputIdx: number; payload: unknown }[] = [];
          for (let i = 0; i < inputs.length; i++) {
            const parts = embeddingInputToMultimodalPayload(inputs[i]!);
            for (const p of parts) {
              allItems.push({ inputIdx: i, payload: p });
            }
          }

          const rawVecs = await client.embedMultimodal(
            allItems.map((item) => item.payload as Parameters<typeof client.embedMultimodal>[0][0]),
            mmModel,
          );

          const grouped = new Map<number, number[][]>();
          for (let j = 0; j < allItems.length; j++) {
            const idx = allItems[j]!.inputIdx;
            if (!grouped.has(idx)) grouped.set(idx, []);
            grouped.get(idx)!.push(rawVecs[j]!);
          }

          const results: number[][] = [];
          for (let i = 0; i < inputs.length; i++) {
            const vecs = grouped.get(i);
            if (!vecs || vecs.length === 0) {
              results.push([]);
              continue;
            }
            if (vecs.length === 1) {
              results.push(vecs[0]!);
              continue;
            }
            results.push(averageVectors(vecs));
          }
          return results;
        },
      };

      return {
        provider,
        runtime: {
          id: "oasis-semantics",
          inlineBatchTimeoutMs: 5 * 60_000,
          cacheKeyData: {
            provider: "oasis-semantics",
            model: resolvedModel,
          },
        },
      };
    },

    formatSetupError: (err: unknown): string => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
        return (
          "Cannot reach the oasis-semantics sidecar. " +
          "Make sure the container is running and the endpoint is correct " +
          `(configured: ${clientConfig.endpoint ?? "http://oasis-semantics:8732"}).`
        );
      }
      return `oasis-semantics embedding error: ${msg}`;
    },
  };
}

function averageVectors(vecs: number[][]): number[] {
  const dim = vecs[0]!.length;
  const avg = new Array<number>(dim).fill(0);
  for (const vec of vecs) {
    for (let i = 0; i < dim; i++) {
      avg[i]! += vec[i]!;
    }
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    avg[i]! /= vecs.length;
    norm += avg[i]! * avg[i]!;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      avg[i]! /= norm;
    }
  }
  return avg;
}
