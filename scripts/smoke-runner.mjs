/**
 * oasis-claw plugin smoke test runner
 *
 * Directly exercises each plugin's register() function against a mock
 * OpenClawPluginApi, verifying that all tools/hooks/supplements register
 * without throwing. No live openclaw runtime required.
 *
 * Exit 0 = all plugins loaded cleanly.
 * Exit 1 = at least one plugin threw during registration.
 *
 * Run inside the smoke container:
 *   node --import tsx/esm scripts/smoke-runner.mjs
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Mock OpenClawPluginApi
// ---------------------------------------------------------------------------

function makeMockApi(pluginId, pluginConfig = {}) {
  const registered = {
    tools: [],
    hooks: [],
    memorySupplement: null,
    compactionProvider: null,
  };

  const api = {
    id: pluginId,
    name: pluginId,
    source: "local",
    config: {},
    pluginConfig,
    runtime: { stateDir: `/tmp/oasis-smoke/${pluginId}` },
    logger: {
      info: (msg, meta) => log("INFO", pluginId, msg, meta),
      warn: (msg, meta) => log("WARN", pluginId, msg, meta),
      error: (msg, meta) => log("ERROR", pluginId, msg, meta),
      debug: () => {},
    },
    registerTool(tool, opts) {
      const name = opts?.name ?? tool.name ?? "(unnamed)";
      registered.tools.push(name);
      log("TOOL", pluginId, `registered tool: ${name}`);
    },
    on(hookName, _handler, _opts) {
      registered.hooks.push(hookName);
      log("HOOK", pluginId, `registered hook: ${hookName}`);
    },
    registerHook(events, _handler, _opts) {
      const names = Array.isArray(events) ? events : [events];
      registered.hooks.push(...names);
      log("HOOK", pluginId, `registered hook(s): ${names.join(", ")}`);
    },
    registerMemoryPromptSupplement(builder) {
      registered.memorySupplement = builder;
      const lines = builder({ availableTools: new Set(registered.tools) });
      log("MEMORY", pluginId, `supplement produced ${lines.length} lines`);
      if (lines.length === 0) throw new Error("supplement returned 0 lines");
    },
    registerMemoryCapability(_cap) {
      log("MEMORY", pluginId, "registerMemoryCapability called");
    },
    registerCompactionProvider(provider) {
      registered.compactionProvider = provider;
      log("COMPACT", pluginId, `compaction provider registered: ${provider.id}`);
    },
    resolvePath: (p) => p,
    // Stub out everything else so unknown calls don't throw
    registerChannel: noop,
    registerCli: noop,
    registerGatewayMethod: noop,
    registerHttpRoute: noop,
    registerService: noop,
    registerReload: noop,
    registerNodeHostCommand: noop,
    registerSecurityAuditCollector: noop,
    registerGatewayDiscoveryService: noop,
    registerCliBackend: noop,
    registerTextTransforms: noop,
    registerConfigMigration: noop,
    registerMigrationProvider: noop,
    registerAutoEnableProbe: noop,
    registerProvider: noop,
    registerSpeechProvider: noop,
    registerRealtimeTranscriptionProvider: noop,
    registerRealtimeVoiceProvider: noop,
    registerMediaUnderstandingProvider: noop,
    registerImageGenerationProvider: noop,
    registerVideoGenerationProvider: noop,
    registerMusicGenerationProvider: noop,
    registerWebFetchProvider: noop,
    registerWebSearchProvider: noop,
    registerInteractiveHandler: noop,
    onConversationBindingResolved: noop,
    registerCommand: noop,
    registerContextEngine: noop,
    registerAgentHarness: noop,
    registerCodexAppServerExtensionFactory: noop,
    registerAgentToolResultMiddleware: noop,
    registerDetachedTaskRuntime: noop,
    registerMemoryFlushPlan: noop,
    registerMemoryRuntime: noop,
    registerMemoryEmbeddingProvider: noop,
    registerMemoryCorpusSupplement: noop,
  };

  return { api, registered };
}

const noop = () => {};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

function log(level, plugin, msg, meta) {
  const color = level === "ERROR" ? RED : level === "WARN" ? YELLOW : level === "TOOL" || level === "HOOK" || level === "MEMORY" || level === "COMPACT" ? CYAN : DIM;
  const metaStr = meta ? ` ${DIM}${JSON.stringify(meta)}${RESET}` : "";
  console.log(`${color}[${level}]${RESET} ${DIM}${plugin}${RESET}  ${msg}${metaStr}`);
}

// ---------------------------------------------------------------------------
// Plugin definitions to test
// ---------------------------------------------------------------------------

// swarmDir must exist for dot-swarm to produce lines
import { mkdirSync, writeFileSync } from "node:fs";
const SMOKE_SWARM = "/tmp/oasis-smoke/.swarm";
mkdirSync(SMOKE_SWARM, { recursive: true });
writeFileSync(`${SMOKE_SWARM}/state.md`, "# Smoke test state\n\nPlugin registration smoke test.\n");
writeFileSync(`${SMOKE_SWARM}/queue.md`, "# Smoke test queue\n\n- [ ] verify all plugins load\n");

const PLUGINS = [
  {
    id: "prompt-injection-reporting",
    path: path.join(ROOT, "extensions/prompt-injection-reporting/index.ts"),
    config: {},
    expect: { minTools: 1 },
  },
  {
    id: "secrets-vault",
    path: path.join(ROOT, "extensions/secrets-vault/index.ts"),
    config: {},
    expect: { minTools: 1 },
  },
  {
    id: "approval-gate",
    path: path.join(ROOT, "extensions/approval-gate/index.ts"),
    config: {
      telegramBotToken: "smoke-test-token",
      telegramChatId: "smoke-test-chat",
    },
    expect: { minTools: 1 },
  },
  {
    id: "session-history",
    path: path.join(ROOT, "extensions/session-history/index.ts"),
    config: { logDir: "/tmp/oasis-smoke/history" },
    expect: { minHooks: 1 },
  },
  {
    id: "dot-swarm",
    path: path.join(ROOT, "extensions/dot-swarm/index.ts"),
    config: { swarmDir: SMOKE_SWARM },
    expect: { memorySupplement: true, minTools: 1 },
  },
  {
    id: "agent-primitives",
    path: path.join(ROOT, "extensions/agent-primitives/index.ts"),
    config: { swarmDir: SMOKE_SWARM },
    expect: { minTools: 3, compactionProvider: true },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

for (const def of PLUGINS) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${CYAN}▶ ${def.id}${RESET}`);

  try {
    const mod = await import(def.path);
    const plugin = mod.default ?? mod;

    if (typeof plugin.register !== "function") {
      throw new Error("plugin.register is not a function");
    }

    const { api, registered } = makeMockApi(def.id, def.config);
    await plugin.register(api);

    // Assertions
    const errors = [];

    if (def.expect.minTools && registered.tools.length < def.expect.minTools) {
      errors.push(`expected ≥${def.expect.minTools} tools, got ${registered.tools.length}`);
    }
    if (def.expect.minHooks && registered.hooks.length < def.expect.minHooks) {
      errors.push(`expected ≥${def.expect.minHooks} hooks, got ${registered.hooks.length}`);
    }
    if (def.expect.memorySupplement && !registered.memorySupplement) {
      errors.push("expected registerMemoryPromptSupplement to be called");
    }
    if (def.expect.compactionProvider && !registered.compactionProvider) {
      errors.push("expected registerCompactionProvider to be called");
    }

    if (errors.length > 0) {
      throw new Error(errors.join("; "));
    }

    console.log(`${GREEN}✓ PASS${RESET}  tools=[${registered.tools.join(", ")}]  hooks=[${registered.hooks.join(", ")}]`);
    passed++;
  } catch (err) {
    console.log(`${RED}✗ FAIL${RESET}  ${err.message}`);
    if (process.env.SMOKE_VERBOSE) console.error(err);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"═".repeat(60)}`);
if (failed === 0) {
  console.log(`${GREEN}All ${passed} plugins loaded successfully.${RESET}`);
  process.exit(0);
} else {
  console.log(`${RED}${failed} plugin(s) failed, ${passed} passed.${RESET}`);
  process.exit(1);
}
