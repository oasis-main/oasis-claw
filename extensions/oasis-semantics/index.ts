import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { buildOasisSemanticsAdapter } from "./memory-embedding-adapter.js";

const plugin = {
  id: "oasis-semantics",
  name: "Oasis Semantics",
  description:
    "Local-first embedding provider for memory-core backed by the oasis-semantics sidecar. " +
    "Text tiers: bge-small (default), MiniLM, bge-m3, nomic. " +
    "Multimodal tiers: CLIP, SigLIP (image + text in a shared vector space). " +
    "All weights MIT / Apache-2.0 / CC-BY-4.0 only.",
  register(api: OpenClawPluginApi) {
    api.logger.info("oasis-semantics plugin loaded", {
      pluginConfig: api.pluginConfig,
    });

    const pluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const adapter = buildOasisSemanticsAdapter(pluginConfig);
    api.registerMemoryEmbeddingProvider(adapter);
  },
};

export default plugin;
