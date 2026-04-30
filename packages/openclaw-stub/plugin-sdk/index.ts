/**
 * Minimal type stub for openclaw/plugin-sdk.
 *
 * This package exists so the oasis-claw workspace can resolve
 * `import type { OpenClawPluginApi } from "openclaw/plugin-sdk"` without
 * installing the full upstream openclaw monorepo (which has hundreds of
 * dependencies and requires building its dist/ before types are available).
 *
 * The real openclaw lives at vendor/openclaw/ (pinned to v2026.4.26).
 * Types here are kept in sync manually — they only need to cover the surface
 * actually used by the six oasis-claw extension plugins.
 *
 * DO NOT add runtime code here. All imports in extensions are `import type`.
 */

export type PluginLogger = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  debug: (msg: string, meta?: Record<string, unknown>) => void;
};

export type PluginRuntime = {
  /** Absolute path to plugin-scoped persistent state directory. */
  stateDir: string;
  [key: string]: unknown;
};

export type AnyAgentTool = {
  name: string;
  description: string;
  parameters?: unknown;
  invoke?: (args: unknown) => Promise<unknown>;
  execute?: (toolCallId: string, args: unknown) => Promise<unknown>;
  [key: string]: unknown;
};

/** Builder called to produce additive prompt supplement lines. */
export type MemoryPromptSectionBuilder = (params: {
  availableTools: Set<string>;
  citationsMode?: boolean;
}) => string[];

export type OpenClawPluginApi = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  rootDir?: string;
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  runtime: PluginRuntime;
  logger: PluginLogger;
  /** Register an agent-callable tool. */
  registerTool: (tool: AnyAgentTool, opts?: { name?: string }) => void;
  /** Register a lifecycle hook handler. */
  on: (hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => void;
  /** Register an additive memory-adjacent prompt section (non-exclusive). */
  registerMemoryPromptSupplement: (builder: MemoryPromptSectionBuilder) => void;
  /** Register an exclusive memory backend (only one active at a time). */
  registerMemoryCapability: (capability: unknown) => void;
  registerHook: (events: string | string[], handler: (...args: unknown[]) => unknown, opts?: unknown) => void;
  resolvePath: (input: string) => string;
  [key: string]: unknown;
};
