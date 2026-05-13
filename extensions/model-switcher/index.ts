import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { z } from "zod";

const configSchema = z.object({
  allowedProviders: z.array(z.string()).optional(),
  // When true (default), on plugin load every TIER_CATALOG entry is
  // ensured-present in agents.defaults.models so the upstream `/models` and
  // `/model` channel menus surface the full light/medium/heavy ladder for
  // each foundation provider. Set false to keep the allowlist hand-curated.
  autoAllowlistTiers: z.boolean().default(true),
});

export type ModelSwitcherConfig = z.infer<typeof configSchema>;

// "<provider>/<model>" — model segment may itself contain "/" (e.g. openrouter/moonshotai/kimi-k2).
const MODEL_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_./:-]*$/;

// Tier matrix — light/medium/heavy per foundation provider. Lets the operator
// pick "anthropic:heavy" without remembering today's exact model id. Update
// the model ids here when a provider's family rolls forward; the alias surface
// stays stable.
//
// Every id here is verified against the openclaw model catalog (`openclaw
// models list --all --json`). If you add a new tier or provider, run the same
// command and pin against an entry that actually exists — otherwise the menu
// will show a button that 404s on switch.
type Tier = "light" | "medium" | "heavy";
type TierRow = Readonly<Record<Tier, string>> & { label: string };
const TIER_CATALOG: Readonly<Record<string, TierRow>> = {
  anthropic: {
    label: "Anthropic (Claude)",
    light: "anthropic/claude-haiku-4-5",
    medium: "anthropic/claude-sonnet-4-6",
    heavy: "anthropic/claude-opus-4-7",
  },
  openai: {
    label: "OpenAI (GPT)",
    light: "openai/gpt-5.4-mini",
    medium: "openai/gpt-5.5",
    heavy: "openai/gpt-5.5-pro",
  },
  google: {
    // gemini-3.1-flash-lite is GA as of 2026-05; using it (not the older
    // -preview variant from the local catalog dump) keeps the light tier on
    // the same 3.1 generation as the heavy tier so the ladder reads as one
    // family. Medium stays on 3-pro-preview until 3.1-pro hits GA.
    label: "Google (Gemini)",
    light: "google/gemini-3.1-flash-lite",
    medium: "google/gemini-3-pro-preview",
    heavy: "google/gemini-3.1-pro-preview",
  },
};
const TIER_ALIASES: Readonly<Record<string, string>> = {
  gemini: "google",
  claude: "anthropic",
  gpt: "openai",
};
const VALID_TIERS: readonly Tier[] = ["light", "medium", "heavy"];

function resolveTierShortcut(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  // Accept "<provider>:<tier>" or "<provider> <tier>".
  const m = trimmed.match(/^([a-z0-9_-]+)[\s:]+([a-z]+)$/);
  if (!m) return null;
  const provider = TIER_ALIASES[m[1]!] ?? m[1]!;
  const tier = m[2] as Tier;
  if (!VALID_TIERS.includes(tier)) return null;
  const row = TIER_CATALOG[provider];
  return row ? row[tier] : null;
}

function renderTierMenu(allowed: readonly string[] | undefined): string {
  const lines: string[] = ["Provider tier menu (light / medium / heavy):"];
  for (const [provider, row] of Object.entries(TIER_CATALOG)) {
    if (allowed && allowed.length > 0 && !allowed.includes(provider)) continue;
    lines.push(`  ${provider.padEnd(10)} ${row.label}`);
    lines.push(`    light  → ${row.light}`);
    lines.push(`    medium → ${row.medium}`);
    lines.push(`    heavy  → ${row.heavy}`);
  }
  lines.push("Usage: /setmodel <provider>:<tier>  (e.g. /setmodel anthropic:heavy)");
  return lines.join("\n");
}

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

// Build the set of model refs the tier menu wants in the allowlist, filtered
// by allowedProviders if set. Returns the refs to ensure-present.
function tierAllowlistRefs(allowedProviders: readonly string[] | undefined): string[] {
  const refs: string[] = [];
  for (const [provider, row] of Object.entries(TIER_CATALOG)) {
    if (allowedProviders && allowedProviders.length > 0 && !allowedProviders.includes(provider)) {
      continue;
    }
    refs.push(row.light, row.medium, row.heavy);
  }
  return refs;
}

// Returns { next, added } — `next` has any missing tier refs ensured-present
// in agents.defaults.models with a `{}` value (which is the same shape
// applyPrimary uses for entries it adds). `added` is the list of refs that
// weren't already there. Empty `added` ⇒ caller can skip the config write.
function ensureTiersInAllowlist(
  cfg: AnyConfig,
  allowedProviders: readonly string[] | undefined,
): { next: AnyConfig; added: string[] } {
  const wanted = tierAllowlistRefs(allowedProviders);
  const existing = cfg.agents?.defaults?.models ?? {};
  const missing = wanted.filter((ref) => !(ref in existing));
  if (missing.length === 0) {
    return { next: cfg, added: [] };
  }
  const next = structuredClone(cfg) as AnyConfig;
  const agents = (next.agents ??= {} as NonNullable<AnyConfig["agents"]>);
  const defaults = (agents.defaults ??= {} as NonNullable<NonNullable<AnyConfig["agents"]>["defaults"]>);
  const models = (defaults.models ??= {} as Record<string, unknown>);
  for (const ref of missing) {
    models[ref] = {};
  }
  return { next, added: missing };
}

function reply(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function validateModelRef(
  raw: string,
  allowedProviders: readonly string[] | undefined,
): { ok: true; ref: string } | { ok: false; error: string } {
  // Tier shortcut ("<provider>:<tier>") is sugar; expand before shape-checking.
  const expanded = resolveTierShortcut(raw) ?? raw;
  const ref = expanded.trim();
  if (!MODEL_REF_RE.test(ref)) {
    return {
      ok: false,
      error: `Invalid model reference "${raw}". Expected "<provider>/<model>" (e.g. anthropic/claude-sonnet-4-6) or a tier shortcut like "anthropic:heavy".`,
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

    // ── Auto-allowlist tier models ───────────────────────────────────
    // The upstream `/models` and `/model` channel menus surface entries from
    // agents.defaults.models. Without this the tier ladder is invocable via
    // /setmodel but invisible in the menu — confusing for operators who
    // discover models through the buttons. Run-once-per-boot: idempotent and
    // a no-op when the user has set autoAllowlistTiers=false.
    if (cfg.autoAllowlistTiers) {
      // Fire-and-forget so register() stays sync. If it fails we log but
      // keep the rest of the plugin functional — the tier shortcut still
      // works via /setmodel even with no menu surfacing.
      void (async () => {
        try {
          const current = runtime.config.current();
          const { next, added } = ensureTiersInAllowlist(current, allowedProviders);
          if (added.length === 0) {
            return;
          }
          await runtime.config.replaceConfigFile({
            nextConfig: next,
            afterWrite: { mode: "auto" },
          });
          api.logger.info("model-switcher: auto-allowlisted tier models", { added });
        } catch (err) {
          api.logger.warn("model-switcher: tier auto-allowlist failed", {
            error: (err as Error).message,
          });
        }
      })();
    }

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
        "uses the new model. Accepts either an explicit \"<provider>/<model>\" ref or",
        "a tier shortcut \"<provider>:<tier>\" (tier in light|medium|heavy).",
        "Examples: anthropic/claude-opus-4-7, anthropic:heavy, openai:medium,",
        "google:light, openai-codex/gpt-5.5, ollama/llama3.3.",
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

    // ── Agent tool: tier catalog ─────────────────────────────────────
    api.registerTool({
      name: "list_model_tiers",
      description:
        "List the light/medium/heavy tier mapping per foundation provider that switch_model accepts as a shortcut. Useful when deciding which tier to escalate to.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        const filtered = Object.fromEntries(
          Object.entries(TIER_CATALOG).filter(
            ([k]) => !allowedProviders?.length || allowedProviders.includes(k),
          ),
        );
        return reply({ tiers: filtered });
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
              "Usage: /setmodel <provider>/<model>  |  /setmodel <provider>:<tier>  |  /setmodel menu",
              "",
              renderTierMenu(allowedProviders),
              "",
              "Explicit examples:",
              "  /setmodel anthropic/claude-opus-4-7",
              "  /setmodel openai/gpt-5.5",
              "  /setmodel google/gemini-3.1-pro-preview",
              "  /setmodel ollama/llama3.3",
            ].join("\n") + allowedHint,
          };
        }
        if (arg === "menu" || arg === "list" || arg === "tiers") {
          return {
            text: `Current model: ${cur ?? "<unset>"}\n${renderTierMenu(allowedProviders)}`,
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
      tools: ["switch_model", "current_model", "list_model_tiers"],
      commands: ["/setmodel"],
      allowedProviders: allowedProviders ?? "(unrestricted)",
      tierProviders: Object.keys(TIER_CATALOG),
    });
  },
};

export default plugin;
