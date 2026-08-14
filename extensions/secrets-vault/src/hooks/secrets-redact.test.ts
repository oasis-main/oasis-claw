/**
 * Tests for the tool_result_persist redaction hook (CLAW-097).
 *
 * Covers two things deliberately:
 *  1. The handler-signature bug that made this hook a silent no-op before
 *     this fix (see the module comment in secrets-redact.ts) — every test
 *     here calls the captured handler with the REAL (event, ctx) shape
 *     (event.message.content), not a shortcut. A test using the old, wrong
 *     `ctx.content` shape would have passed against the broken code too,
 *     which is exactly how the bug went unnoticed.
 *  2. The new pattern-based redaction (redactSecretPatterns), which fires
 *     with zero registered secrets — the regression the old early-return
 *     would also have silently skipped.
 *
 * openclaw/plugin-sdk/plugin-test-api is not available inside oasis-claw's
 * own extensions (packages/openclaw-stub does not export that subpath — only
 * the real upstream openclaw monorepo does, e.g. the vendored, workspace-
 * excluded extensions/browser). This mirrors the mock pattern already used by
 * extensions/oasis-reviewer/src/reviewer.loop-guard.test.ts: a minimal
 * hand-rolled OpenClawPluginApi shape, cast through `unknown`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretsStore } from "../secrets-store.js";
import { registerSecretsRedact } from "./secrets-redact.js";

type ToolResultContentBlock = { type: string; text?: string };
type ToolResultMessage = {
  role: string;
  toolCallId: string;
  toolName: string;
  content: ToolResultContentBlock[];
  isError: boolean;
  timestamp: number;
};
type ToolResultPersistEvent = {
  toolName?: string;
  toolCallId?: string;
  message: ToolResultMessage;
  isSynthetic?: boolean;
};
type CapturedHandler = (
  event: ToolResultPersistEvent,
) => { message?: ToolResultMessage } | undefined;

function toolResultEvent(text: string, toolName = "exec"): ToolResultPersistEvent {
  return {
    toolName,
    toolCallId: "call-1",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName,
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 1,
    },
  };
}

function fakeSecretsStore(secrets: Record<string, string>): SecretsStore {
  return {
    list: () => Object.keys(secrets),
    has: (name: string) => name in secrets,
    get: (name: string) => secrets[name] ?? null,
    set: () => {},
    delete: () => {},
  } as unknown as SecretsStore;
}

function makeApi() {
  const handlers = new Map<string, CapturedHandler>();
  const warn = vi.fn();
  const api = {
    on: (name: string, handler: CapturedHandler) => {
      handlers.set(name, handler);
    },
    logger: { info: () => {}, warn, error: () => {}, debug: () => {} },
  } as unknown as Parameters<typeof registerSecretsRedact>[0];
  return { api, handlers, warn };
}

function register(secrets: Record<string, string> = {}, telegram?: { botToken?: string; chatId?: string }) {
  const { api, handlers, warn } = makeApi();
  registerSecretsRedact(api, { secretsStore: fakeSecretsStore(secrets), telegram });
  const handler = handlers.get("tool_result_persist");
  if (!handler) throw new Error("expected registerSecretsRedact to register a tool_result_persist handler");
  return { handler, warn };
}

describe("registerSecretsRedact", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("fires the pattern check with ZERO registered secrets (regression: old early-return skipped this)", () => {
    const { handler } = register({}); // no deposited secrets at all
    const event = toolResultEvent('aws_key = "AKIAIOSFODNN7EXAMPLE"');
    const out = handler(event);
    expect(out?.message?.content[0]?.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out?.message?.content[0]?.text).toContain("[REDACTED BY HYPERCLAW-SECURITY]");
  });

  it("redacts a generic secret-shaped assignment", () => {
    const { handler } = register({});
    const text =
      'tradier_token = "NOTAREALTOKENEXAMPLEPLACEHOLDER0000"\n' +
      'bedrock_aws_secret_access_key = "wJalrXUtnFEMI/K7MDENGEXAMPLEbPxRfiCYFAKE"\n';
    const out = handler(toolResultEvent(text));
    const redacted = out?.message?.content[0]?.text ?? "";
    expect(redacted).not.toContain("NOTAREALTOKENEXAMPLEPLACEHOLDER0000");
    expect(redacted).not.toContain("wJalrXUtnFEMI");
  });

  it("does not false-positive on ordinary code", () => {
    const { handler, warn } = register({});
    const text =
      "def get_quote(symbol: str) -> dict:\n" +
      '    return {"symbol": symbol, "price": 100.0}\n' +
      'API_BASE = "https://api.weather.oasis-x.io"\n';
    const out = handler(toolResultEvent(text));
    expect(out).toBeUndefined(); // no change -> handler returns undefined, not {message}
    expect(warn).not.toHaveBeenCalled();
  });

  it("still redacts an exact-match registered secret (deposit_secret path)", () => {
    const { handler } = register({ tradier: "sk-live-registered-value-123456" });
    const out = handler(toolResultEvent("the token is sk-live-registered-value-123456 here"));
    expect(out?.message?.content[0]?.text).not.toContain("sk-live-registered-value-123456");
  });

  it("never logs the matched secret text itself, only rule names", () => {
    const { handler, warn } = register({});
    handler(toolResultEvent('gemini_api_key = "AQ.NOTREALEXAMPLEPLACEHOLDER_d3vjNOTAKEY"'));
    expect(warn).toHaveBeenCalledTimes(1);
    const [, meta] = warn.mock.calls[0] as [string, { rules?: string[] }];
    const rulesJson = JSON.stringify(meta.rules ?? []);
    expect(rulesJson).not.toContain("AQ.NOTREALEXAMPLEPLACEHOLDER");
    expect(meta.rules).toContain("generic_secret_assignment");
  });

  it("ignores a non-toolResult message shape without throwing", () => {
    const { handler } = register({});
    const event = toolResultEvent("AKIAIOSFODNN7EXAMPLE");
    event.message.role = "assistant"; // deliberately wrong role to exercise the guard
    expect(() => handler(event)).not.toThrow();
    expect(handler(event)).toBeUndefined();
  });

  it("fires a fire-and-forget telegram alert on a match without blocking the synchronous handler", () => {
    const { handler } = register({}, { botToken: "test-token", chatId: "test-chat" });
    const out = handler(toolResultEvent('aws_key = "AKIAIOSFODNN7EXAMPLE"'));
    // The handler itself must return synchronously (fire-and-forget), and the
    // fetch call for the alert must have been issued.
    expect(out?.message?.content[0]?.text).toContain("[REDACTED");
    expect(global.fetch).toHaveBeenCalled();
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain("api.telegram.org");
  });

  it("does not fire a telegram alert when no telegram config is provided", () => {
    const { handler } = register({});
    handler(toolResultEvent('aws_key = "AKIAIOSFODNN7EXAMPLE"'));
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
