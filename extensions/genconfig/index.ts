import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// /genconfig — per-model inference configuration for the oasis-generation gateway.
//
// The gateway is the source of truth for inference params: each model carries an
// InferenceDefaults policy (thinking/effort/temperature + fast|balanced|deep
// profiles) and applies its default profile when the caller sends nothing. This
// plugin is the OPERATOR OVERRIDE channel — it picks a profile (or advanced knob)
// for a specific oasis-generation model and pushes it to the gateway.
//
// HOW THE OVERRIDE REACHES THE GATEWAY (verified against the openclaw 6.11 dist):
// openclaw builds the openai-completions request body from an ALLOWLIST — a
// custom top-level `params.profile` / `params.reasoning_effort` is dropped, and
// because our gateway is a custom baseUrl, `compat.supportsReasoningEffort`
// defaults to false (so the native reasoning_effort path is closed). The one
// verbatim passthrough is `params.extra_body`, which is Object.assign-ed onto the
// outbound JSON body. So we write the override into
//   agents.defaults.models["oasis-generation/<model>"].params.extra_body
// and the gateway reads body["profile"] / body["reasoning_effort"] /
// body["max_tokens"] (see oasis-generation bedrock._resolve_inference). Temperature
// is an allowlisted openai-completions param, so it goes through `params.temperature`
// natively (only offered for models whose capabilities allow it).

const PROVIDER_DEFAULT = "oasis-generation";

interface Capabilities {
  supports_thinking: boolean;
  thinking_forced: boolean;
  supports_effort: boolean;
  effort_levels: string[];
  supports_temperature: boolean;
  supports_sampling: boolean;
  max_output_tokens_ceiling: number | null;
  profiles: string[];
  default_profile: string | null;
}

interface ModelInfo {
  id: string;
  tier?: string;
  capabilities?: Capabilities;
}

type ModelParams = {
  extra_body?: Record<string, unknown>;
  temperature?: number;
} & Record<string, unknown>;

type ModelEntry = { params?: ModelParams } & Record<string, unknown>;

type AnyConfig = Record<string, unknown> & {
  models?: {
    providers?: Record<
      string,
      { baseUrl?: string; apiKey?: string; models?: Array<{ id: string }> } & Record<string, unknown>
    >;
  } & Record<string, unknown>;
  agents?: {
    defaults?: {
      model?: string | { primary?: string; fallbacks?: string[] };
      models?: Record<string, ModelEntry>;
    } & Record<string, unknown>;
  } & Record<string, unknown>;
};

// ── pure helpers (unit-tested) ───────────────────────────────────────────────

export function readPrimary(cfg: AnyConfig | undefined): string | undefined {
  const m = cfg?.agents?.defaults?.model;
  if (!m) return undefined;
  if (typeof m === "string") return m;
  return typeof m.primary === "string" ? m.primary : undefined;
}

export function providerConf(
  cfg: AnyConfig | undefined,
  providerId: string,
): { baseUrl?: string; apiKey?: string } | undefined {
  return cfg?.models?.providers?.[providerId];
}

// Given a "provider/model" ref and the target provider id, return the bare model
// id if the ref belongs to that provider, else null.
export function modelIdForProvider(ref: string | undefined, providerId: string): string | null {
  if (!ref) return null;
  const prefix = `${providerId}/`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}

export function currentModelParams(cfg: AnyConfig, modelKey: string): ModelParams {
  return cfg.agents?.defaults?.models?.[modelKey]?.params ?? {};
}

// Merge a params patch into agents.defaults.models[modelKey].params (immutably).
// `mergeExtraBody`: when true, extra_body keys merge; when false, extra_body is
// replaced wholesale (used by profile selection, which is a clean reset).
export function applyModelParams(
  cfg: AnyConfig,
  modelKey: string,
  patch: { extra_body?: Record<string, unknown>; temperature?: number | null },
  mergeExtraBody: boolean,
): AnyConfig {
  const next = structuredClone(cfg) as AnyConfig;
  const agents = (next.agents ??= {});
  const defaults = (agents.defaults ??= {});
  const models = (defaults.models ??= {});
  const entry = (models[modelKey] ??= {});
  const params: ModelParams = { ...(entry.params ?? {}) };

  if (patch.extra_body !== undefined) {
    params.extra_body = mergeExtraBody
      ? { ...(params.extra_body ?? {}), ...patch.extra_body }
      : { ...patch.extra_body };
  }
  if (patch.temperature === null) {
    delete params.temperature;
  } else if (patch.temperature !== undefined) {
    params.temperature = patch.temperature;
  }
  entry.params = params;
  // Seed the allowlist so the model stays /model-selectable (mirrors the
  // entrypoint's seed-if-absent; a no-op when already present).
  if (!(modelKey in models)) models[modelKey] = entry;
  return next;
}

export function clearModelParams(cfg: AnyConfig, modelKey: string): AnyConfig {
  const next = structuredClone(cfg) as AnyConfig;
  const entry = next.agents?.defaults?.models?.[modelKey];
  if (entry && "params" in entry) delete entry.params;
  return next;
}

export function validateProfile(
  caps: Capabilities | undefined,
  profile: string,
): { ok: true } | { ok: false; error: string } {
  const known = caps?.profiles?.length ? caps.profiles : ["fast", "balanced", "deep"];
  if (!known.includes(profile)) {
    return { ok: false, error: `Unknown profile "${profile}". Available: ${known.join(", ")}.` };
  }
  return { ok: true };
}

export function validateEffort(
  caps: Capabilities | undefined,
  effort: string,
): { ok: true } | { ok: false; error: string } {
  if (caps && !caps.supports_effort) {
    return { ok: false, error: "This model has no gateway-controllable effort (thinking is native/off)." };
  }
  const levels = caps?.effort_levels?.length ? caps.effort_levels : ["low", "medium", "high", "xhigh", "max"];
  if (!levels.includes(effort)) {
    return { ok: false, error: `Unsupported effort "${effort}" for this model. Supported: ${levels.join(", ")}.` };
  }
  return { ok: true };
}

// Render the per-model control surface — ONLY the knobs the model supports.
export function renderModelStatus(modelId: string, caps: Capabilities | undefined, params: ModelParams): string {
  const eb = (params.extra_body ?? {}) as Record<string, unknown>;
  const lines: string[] = [`⚙️ ${modelId}`];
  if (!caps) {
    lines.push("  (capability info unavailable — gateway unreachable; overrides still apply)");
  } else {
    const thinking = caps.thinking_forced
      ? "always on"
      : caps.supports_thinking
        ? "adaptive (gateway-controlled)"
        : "native / not controllable";
    lines.push(`  thinking: ${thinking}`);
    if (caps.supports_effort) lines.push(`  effort:   ${caps.effort_levels.join(" / ")}`);
    lines.push(`  profiles: ${caps.profiles.join(" / ")} (default: ${caps.default_profile ?? "?"})`);
    if (caps.max_output_tokens_ceiling) lines.push(`  max_tokens ceiling: ${caps.max_output_tokens_ceiling}`);
    lines.push(`  temperature: ${caps.supports_temperature ? "supported" : "not supported (hidden)"}`);
  }
  const override: string[] = [];
  if (eb.profile) override.push(`profile=${String(eb.profile)}`);
  if (eb.reasoning_effort) override.push(`effort=${String(eb.reasoning_effort)}`);
  if (eb.max_tokens) override.push(`max_tokens=${String(eb.max_tokens)}`);
  if (typeof params.temperature === "number") override.push(`temperature=${params.temperature}`);
  lines.push(`  → active override: ${override.length ? override.join(", ") : "(none — gateway default profile)"}`);
  return lines.join("\n");
}

// ── plugin ───────────────────────────────────────────────────────────────────

const plugin = {
  id: "genconfig",
  name: "Generation Config",
  description:
    "/genconfig — per-model inference config (profile / effort / max_tokens / temperature) for the oasis-generation gateway, " +
    "rendering only the controls each model supports (from /v1/models capabilities) and writing the override via params.extra_body.",

  configSchema: {
    parse(raw: unknown) {
      const obj = (raw ?? {}) as { providerId?: unknown };
      const providerId = typeof obj.providerId === "string" && obj.providerId.trim() ? obj.providerId.trim() : PROVIDER_DEFAULT;
      return { providerId };
    },
  },

  register(api: OpenClawPluginApi) {
    const cfg = plugin.configSchema.parse(api.pluginConfig ?? {});
    const providerId = cfg.providerId;

    const runtime = api.runtime as unknown as {
      config: {
        current: () => AnyConfig;
        replaceConfigFile: (params: {
          nextConfig: AnyConfig;
          afterWrite?: { mode?: "auto" | "manual" | "defer" };
        }) => Promise<unknown>;
      };
    };

    async function fetchModels(): Promise<ModelInfo[] | null> {
      const prov = providerConf(runtime.config.current(), providerId);
      if (!prov?.baseUrl) return null;
      const url = `${prov.baseUrl.replace(/\/$/, "")}/models`;
      try {
        const resp = await fetch(url, {
          headers: prov.apiKey ? { Authorization: `Bearer ${prov.apiKey}` } : {},
        });
        if (!resp.ok) return null;
        const body = (await resp.json()) as { data?: ModelInfo[] };
        return Array.isArray(body.data) ? body.data : null;
      } catch (err) {
        api.logger.warn("genconfig: /v1/models fetch failed", { error: (err as Error).message });
        return null;
      }
    }

    async function capsFor(modelId: string): Promise<Capabilities | undefined> {
      const models = await fetchModels();
      return models?.find((m) => m.id === modelId)?.capabilities;
    }

    // Resolve the oasis-generation model this command targets: an explicit
    // trailing model arg, else the active primary if it's an oasis-generation model.
    function resolveTarget(explicit: string | undefined): { modelId: string } | { error: string } {
      if (explicit) {
        const id = modelIdForProvider(explicit, providerId) ?? explicit;
        return { modelId: id };
      }
      const primary = readPrimary(runtime.config.current());
      const id = modelIdForProvider(primary, providerId);
      if (!id) {
        return {
          error: `Current model (${primary ?? "<unset>"}) is not an ${providerId} model. ` +
            `Switch to one with /setmodel ${providerId}/<model>, or pass the model explicitly: /genconfig <profile> <model>.`,
        };
      }
      return { modelId: id };
    }

    async function writeExtraBody(
      modelId: string,
      patch: Record<string, unknown>,
      mergeExtraBody: boolean,
    ): Promise<{ ok: true } | { ok: false; error: string }> {
      const modelKey = `${providerId}/${modelId}`;
      const next = applyModelParams(runtime.config.current(), modelKey, { extra_body: patch }, mergeExtraBody);
      try {
        await runtime.config.replaceConfigFile({ nextConfig: next, afterWrite: { mode: "auto" } });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: `Failed to persist: ${(err as Error).message}` };
      }
    }

    async function renderStatus(explicitModel?: string): Promise<string> {
      const target = resolveTarget(explicitModel);
      if ("error" in target) return target.error;
      const caps = await capsFor(target.modelId);
      const params = currentModelParams(runtime.config.current(), `${providerId}/${target.modelId}`);
      return renderModelStatus(target.modelId, caps, params);
    }

    function help(): string {
      return [
        "/genconfig — per-model inference config for the oasis-generation gateway.",
        "",
        "  /genconfig                      show the active model's controls + current override",
        "  /genconfig <profile> [model]    set a profile: fast | balanced | deep",
        "  /genconfig effort <level> [m]   advanced: override reasoning effort (low..max)",
        "  /genconfig maxtokens <n> [m]    advanced: override output token cap",
        "  /genconfig temp <value> [m]     set temperature (only where the model allows it)",
        "  /genconfig reset [model]        clear this model's override (revert to gateway default)",
        "  /genconfig list                 list all gateway models + their controls",
        "",
        "The gateway is the source of truth; a profile expands per-model to a valid",
        "thinking/effort/max_tokens set (e.g. no temperature on models that reject it).",
      ].join("\n");
    }

    async function renderList(): Promise<string> {
      const models = await fetchModels();
      if (!models) return "Gateway /v1/models unreachable (check the provider baseUrl/token).";
      const lines = [`oasis-generation models (${models.length}):`];
      for (const m of models) {
        const c = m.capabilities;
        const bits: string[] = [];
        if (c?.supports_thinking) bits.push("thinking");
        if (c?.supports_effort) bits.push(`effort[${c.effort_levels.join("/")}]`);
        if (c?.supports_temperature) bits.push("temp");
        if (c?.max_output_tokens_ceiling) bits.push(`≤${c.max_output_tokens_ceiling}tok`);
        lines.push(`  ${m.id}${m.tier ? ` (${m.tier})` : ""}: ${bits.join(", ") || "no controls"}`);
      }
      return lines.join("\n");
    }

    const apiAny = api as unknown as {
      registerCommand: (def: {
        name: string;
        description: string;
        acceptsArgs?: boolean;
        requireAuth?: boolean;
        handler: (ctx: { args?: string }) => Promise<{ text: string }> | { text: string };
      }) => void;
      registerTool?: OpenClawPluginApi["registerTool"];
    };

    apiAny.registerCommand({
      name: "genconfig",
      description:
        "Per-model inference config for the oasis-generation gateway (profile/effort/max_tokens/temperature). Bypasses the LLM.",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        const raw = (ctx.args ?? "").trim();
        if (!raw || raw === "status") return { text: await renderStatus() };
        if (raw === "help") return { text: help() };
        if (raw === "list" || raw === "menu") return { text: await renderList() };

        const [verb, ...rest] = raw.split(/\s+/);
        const v = (verb ?? "").toLowerCase();

        // Sub-commands with a value + optional trailing model.
        if (v === "effort" || v === "maxtokens" || v === "temp") {
          const value = rest[0];
          const explicitModel = rest[1];
          if (!value) return { text: `⚠️ Usage: /genconfig ${v} <value> [model]` };
          const target = resolveTarget(explicitModel);
          if ("error" in target) return { text: `⚠️ ${target.error}` };
          const caps = await capsFor(target.modelId);

          if (v === "effort") {
            const eff = value.toLowerCase();
            const check = validateEffort(caps, eff);
            if (!check.ok) return { text: `⚠️ ${check.error}` };
            const res = await writeExtraBody(target.modelId, { reasoning_effort: eff }, true);
            return { text: res.ok ? `✅ ${target.modelId}: effort override → ${eff}` : `⚠️ ${res.error}` };
          }
          if (v === "maxtokens") {
            const n = Number(value);
            if (!Number.isInteger(n) || n <= 0) return { text: `⚠️ max_tokens must be a positive integer.` };
            const ceiling = caps?.max_output_tokens_ceiling ?? null;
            if (ceiling && n > ceiling) return { text: `⚠️ ${n} exceeds this model's ceiling (${ceiling}).` };
            const res = await writeExtraBody(target.modelId, { max_tokens: n }, true);
            return { text: res.ok ? `✅ ${target.modelId}: max_tokens override → ${n}` : `⚠️ ${res.error}` };
          }
          // temp
          const t = Number(value);
          if (Number.isNaN(t) || t < 0 || t > 2) return { text: `⚠️ temperature must be between 0 and 2.` };
          if (caps && !caps.supports_temperature) {
            return { text: `⚠️ ${target.modelId} does not support temperature (it 400s on it) — control hidden.` };
          }
          const modelKey = `${providerId}/${target.modelId}`;
          const next = applyModelParams(runtime.config.current(), modelKey, { temperature: t }, true);
          try {
            await runtime.config.replaceConfigFile({ nextConfig: next, afterWrite: { mode: "auto" } });
            return { text: `✅ ${target.modelId}: temperature → ${t}` };
          } catch (err) {
            return { text: `⚠️ Failed to persist: ${(err as Error).message}` };
          }
        }

        if (v === "reset") {
          const target = resolveTarget(rest[0]);
          if ("error" in target) return { text: `⚠️ ${target.error}` };
          const next = clearModelParams(runtime.config.current(), `${providerId}/${target.modelId}`);
          try {
            await runtime.config.replaceConfigFile({ nextConfig: next, afterWrite: { mode: "auto" } });
            return { text: `✅ ${target.modelId}: override cleared — reverts to the gateway default profile.` };
          } catch (err) {
            return { text: `⚠️ Failed to persist: ${(err as Error).message}` };
          }
        }

        // Otherwise treat the first token as a profile name.
        const profile = v;
        const explicitModel = rest[0];
        const target = resolveTarget(explicitModel);
        if ("error" in target) return { text: `⚠️ ${target.error}` };
        const caps = await capsFor(target.modelId);
        const check = validateProfile(caps, profile);
        if (!check.ok) return { text: `⚠️ ${check.error}\n\n${help()}` };
        // Profile selection is a clean reset of extra_body (drops prior effort/max overrides).
        const res = await writeExtraBody(target.modelId, { profile }, false);
        if (!res.ok) return { text: `⚠️ ${res.error}` };
        api.logger.info("genconfig: profile set", { model: target.modelId, profile });
        return { text: `✅ ${target.modelId}: profile → ${profile}\n\n${await renderStatus(explicitModel)}` };
      },
    });

    // Read-only agent tool so the model can inspect its own inference controls.
    if (apiAny.registerTool) {
      apiAny.registerTool({
        name: "gen_config",
        description:
          "Report the current oasis-generation model's inference controls (supported thinking/effort/temperature, profiles) and the active override. Read-only.",
        parameters: { type: "object", additionalProperties: false, properties: {} },
        async execute() {
          const text = await renderStatus();
          return { content: [{ type: "text" as const, text }] };
        },
      });
    }

    api.logger.info("genconfig plugin loaded", { providerId, commands: ["/genconfig"], tools: ["gen_config"] });
  },
};

export default plugin;
