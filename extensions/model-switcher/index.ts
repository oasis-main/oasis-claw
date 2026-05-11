import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { z } from "zod";

const configSchema = z.object({
  allowedProviders: z.array(z.string()).optional(),
});

export type ModelSwitcherConfig = z.infer<typeof configSchema>;

// "<provider>/<model>" — model segment may itself contain "/" (e.g. openrouter/moonshotai/kimi-k2).
const MODEL_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_./:-]*$/;

type AnyConfig = Record<string, unknown> & {
  agents?: {
    defaults?: {
      model?: string | { primary?: string; fallbacks?: string[] };
      models?: Record<string, unknown>;
    } & Record<string, unknown>;
  } & Record<string, unknown>;
};

function readPrimary(cfg: AnyConfig | undefined): string | undefined {
  const m = cfg?.agents?.defaults?.model;
  if (!m) return undefined;
  if (typeof m === "string") return m;
  return typeof m.primary === "string" ? m.primary : undefined;
}

function applyPrimary(cfg: AnyConfig, modelRef: string): AnyConfig {
  const next = structuredClone(cfg) as AnyConfig;
  const agents = (next.agents ??= {} as NonNullable<AnyConfig["agents"]>);
  const defaults = (agents.defaults ??= {} as NonNullable<NonNullable<AnyConfig["agents"]>["defaults"]>);
  const existing = defaults.model;
  if (existing && typeof existing === "object") {
    defaults.model = { ...existing, primary: modelRef };
  } else {
    defaults.model = { primary: modelRef };
  }
  // Make sure the model key exists in the catalog. Without this entry the
  // resolver may refuse the primary (see applyDefaultModelPrimaryUpdate in
  // upstream src/commands/models/shared.ts).
  const models = (defaults.models ??= {} as Record<string, unknown>);
  if (!models[modelRef]) models[modelRef] = {};
  return next;
}

function reply(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function validateModelRef(
  raw: string,
  allowedProviders: readonly string[] | undefined,
): { ok: true; ref: string } | { ok: false; error: string } {
  const ref = raw.trim();
  if (!MODEL_REF_RE.test(ref)) {
    return {
      ok: false,
      error: `Invalid model reference "${raw}". Expected "<provider>/<model>" (e.g. anthropic/claude-sonnet-4-6).`,
    };
  }
  if (allowedProviders && allowedProviders.length > 0) {
    const provider = ref.split("/", 1)[0]!;
    if (!allowedProviders.includes(provider)) {
      return {
        ok: false,
        error: `Provider "${provider}" not in allowedProviders (${allowedProviders.join(", ")}).`,
      };
    }
  }
  return { ok: true, ref };
}

const plugin = {
  id: "model-switcher",
  name: "Model Switcher",
  description:
    "Agent tool (switch_model) + bypass slash command (/setmodel) for hot-swapping the default LLM. " +
    "Writes via api.runtime.config.replaceConfigFile with afterWrite.mode=auto so the gateway picks up the new model on the next turn.",

  configSchema: {
    parse(raw: unknown) {
      return configSchema.parse(raw ?? {});
    },
  },

  register(api: OpenClawPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig ?? {});
    const allowedProviders = cfg.allowedProviders;

    // The runtime is typed as `unknown` in the local stub; cast to the shape
    // documented in vendor/openclaw/src/plugins/runtime/types-core.ts.
    const runtime = api.runtime as unknown as {
      config: {
        current: () => AnyConfig;
        replaceConfigFile: (params: {
          nextConfig: AnyConfig;
          afterWrite?: { mode?: "auto" | "manual" | "defer" };
        }) => Promise<unknown>;
      };
    };

    async function performSwitch(target: string): Promise<
      | { ok: true; previous: string | null; model: string; noop?: boolean }
      | { ok: false; error: string }
    > {
      const current = runtime.config.current();
      const previous = readPrimary(current) ?? null;
      if (previous === target) {
        return { ok: true, previous, model: target, noop: true };
      }
      const next = applyPrimary(current, target);
      try {
        await runtime.config.replaceConfigFile({
          nextConfig: next,
          afterWrite: { mode: "auto" },
        });
      } catch (err) {
        return { ok: false, error: `Failed to persist model switch: ${(err as Error).message}` };
      }
      return { ok: true, previous, model: target };
    }

    // ── Agent tool: self-referencing model swap ──────────────────────
    api.registerTool({
      name: "switch_model",
      description: [
        "Swap the default LLM the agent runs on. Persists to ~/.openclaw/openclaw.json",
        "and triggers a hot config reload, so the next turn (and every turn after)",
        "uses the new model. Format: \"<provider>/<model>\".",
        "Examples: anthropic/claude-sonnet-4-6, openai/gpt-4o, gemini/gemini-2.0-flash,",
        "openai-codex/gpt-5.5, ollama/llama3.3.",
        "Provider auth (API key or OAuth profile) must already be configured —",
        "this tool only changes the routing target; it does not provision creds.",
      ].join(" "),
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["model"],
        properties: {
          model: {
            type: "string",
            description: "<provider>/<model> reference, e.g. \"anthropic/claude-sonnet-4-6\".",
          },
          reason: {
            type: "string",
            description: "Optional one-line note (logged for the operator and the audit trail).",
          },
        },
      },
      async execute(_id: string, args: { model: string; reason?: string }) {
        const validation = validateModelRef(args.model, allowedProviders);
        if (!validation.ok) {
          return reply({ ok: false, error: validation.error });
        }
        const result = await performSwitch(validation.ref);
        if (result.ok) {
          api.logger.info("model-switcher: switch_model", {
            previous: result.previous,
            model: result.model,
            noop: result.noop ?? false,
            reason: args.reason ?? null,
          });
        } else {
          api.logger.warn("model-switcher: switch_model failed", {
            target: validation.ref,
            error: result.error,
          });
        }
        return reply({ ...result, reason: args.reason ?? null });
      },
    });

    // ── Agent tool: read-only inspection ─────────────────────────────
    api.registerTool({
      name: "current_model",
      description:
        "Report the currently active default model (provider/model). Useful before deciding whether to call switch_model.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        const current = runtime.config.current();
        return reply({ model: readPrimary(current) ?? null });
      },
    });

    // ── Slash command: bypasses the LLM entirely ─────────────────────
    // Plugin commands are processed before the agent runs (see
    // OpenClawPluginCommandDefinition docs in vendor/openclaw/src/plugins/types.ts),
    // so /setmodel still works when generation is broken from the start
    // (e.g. missing ANTHROPIC_API_KEY, expired OAuth, downed Ollama).
    // Built-in /model exists; we register a separate name so we never collide
    // with or shadow the upstream command.
    const apiAny = api as unknown as {
      registerCommand: (def: {
        name: string;
        description: string;
        acceptsArgs?: boolean;
        requireAuth?: boolean;
        handler: (ctx: {
          args?: string;
          gatewayClientScopes?: readonly string[];
        }) => Promise<{ text: string }> | { text: string };
      }) => void;
    };

    apiAny.registerCommand({
      name: "setmodel",
      description:
        "Set the active default LLM. Bypasses the agent so it works even when generation is broken. Usage: /setmodel <provider>/<model>",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        const arg = (ctx.args ?? "").trim();
        const current = runtime.config.current();
        const cur = readPrimary(current);
        if (!arg || arg === "status" || arg === "help") {
          const allowedHint = allowedProviders?.length
            ? `\nAllowed providers: ${allowedProviders.join(", ")}`
            : "";
          return {
            text: [
              `Current model: ${cur ?? "<unset>"}`,
              "Usage: /setmodel <provider>/<model>",
              "Examples:",
              "  /setmodel anthropic/claude-sonnet-4-6",
              "  /setmodel openai/gpt-4o",
              "  /setmodel gemini/gemini-2.0-flash",
              "  /setmodel ollama/llama3.3",
            ].join("\n") + allowedHint,
          };
        }
        const validation = validateModelRef(arg, allowedProviders);
        if (!validation.ok) {
          return { text: `⚠️ ${validation.error}` };
        }
        const result = await performSwitch(validation.ref);
        if (!result.ok) {
          return { text: `⚠️ ${result.error}` };
        }
        if (result.noop) {
          return { text: `✅ Already on ${result.model} — no change.` };
        }
        api.logger.info("model-switcher: /setmodel", {
          previous: result.previous,
          model: result.model,
        });
        return {
          text: `✅ Model switched: ${result.previous ?? "<unset>"} → ${result.model}\nThe next turn will use the new model.`,
        };
      },
    });

    api.logger.info("model-switcher plugin loaded", {
      tools: ["switch_model", "current_model"],
      commands: ["/setmodel"],
      allowedProviders: allowedProviders ?? "(unrestricted)",
    });
  },
};

export default plugin;
