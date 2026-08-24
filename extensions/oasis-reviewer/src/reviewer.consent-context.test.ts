import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerReviewer } from "./reviewer.js";

// ── Generalized consent-context fix + retry-hint feedback (2026-08-24) ───────
// Two Mike-requested follow-ups to the same-day reviewer permissiveness pass:
//   1. A real trade-approval incident: House proposed a specific order, Mike
//      replied "Go for it", and the Layer 2 judge escalated it anyway — it
//      never sees the bot's own prior turn, only Mike's words. Generalized
//      (not trade-specific): before_agent_finalize now ALWAYS captures the
//      bot's last message so before_tool_call can hand it to the judge.
//   2. Denial/escalation feedback: a deny/escalate now carries an actionable
//      retryHint (Layer 1 static for the three shape rules, Layer 2
//      model-generated for everything else) instead of a bare refusal.
// registerReviewer is an integration surface, so this drives it through a
// minimal mock of the OpenClawPluginApi shape it actually uses, mirroring
// reviewer.loop-guard.test.ts / reviewer.injection-review.test.ts.

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function makeApi(completeImpl?: (params: Record<string, unknown>) => Promise<{ text: string }>) {
  const handlers = new Map<string, Handler>();
  return {
    api: {
      on: (name: string, handler: Handler) => {
        handlers.set(name, handler);
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      pluginConfig: {},
      runtime: completeImpl ? { llm: { complete: completeImpl } } : undefined,
    } as unknown as Parameters<typeof registerReviewer>[0],
    handlers,
  };
}

let tmpDir: string;
let auditDir: string;
let policyPath: string;

// Minimal fleet-only policy: non-empty constitution is enough to make Layer 2
// eligible for an ordinary exec call (no per-bot overrides needed for these
// tests). loadPolicyFile caches at module scope keyed on nothing but the
// FIRST call, so every test in this file must load equivalent content —
// writing the exact same JSON every time keeps that caching harmless.
function writePolicy(): string {
  const p = path.join(tmpDir, "reviewer-policy.json");
  fs.writeFileSync(
    p,
    JSON.stringify({
      constitution: { fleet: ["Serve Mike's genuine intent."], per_bot: {} },
      hard: { fleet: {}, per_bot: {} },
    }),
  );
  return p;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-reviewer-consent-context-test-"));
  auditDir = path.join(tmpDir, "logs", "reviewer");
  policyPath = writePolicy();
  process.env.OASIS_REVIEWER_L2 = "enforce";
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.OASIS_REVIEWER_L2;
});

function readAuditRows(): Record<string, unknown>[] {
  const auditFile = path.join(auditDir, "reviewer-audit.jsonl");
  if (!fs.existsSync(auditFile)) return [];
  return fs
    .readFileSync(auditFile, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const EXEC_EVENT = {
  toolName: "exec",
  toolCallId: "toolu_test1",
  params: { command: "python3 place_iau_call.py" },
};

describe("last-assistant-message capture — general context fix", () => {
  it("flows the bot's last message into the Layer 2 prompt for a call in the same session", async () => {
    let capturedPrompt = "";
    const complete = vi.fn(async (params: Record<string, unknown>) => {
      capturedPrompt = String((params as { messages: { content: string }[] }).messages[0]?.content ?? "");
      return { text: '{"verdict":"allow","principle":"PRIME DIRECTIVE","reason":"matches the confirmed order"}' };
    });
    const { api, handlers } = makeApi(complete);
    registerReviewer(api, { auditDir, mode: "enforce", policyFile: policyPath });

    const finalizeHandler = handlers.get("before_agent_finalize")!;
    const toolCallHandler = handlers.get("before_tool_call")!;

    const sessionId = "trade-session-1";
    finalizeHandler(
      { sessionId, lastAssistantMessage: "Please confirm this exact order: 1x IAU Jan 15, 2027 $100C, buy-to-open limit $2.50, Day." },
      {},
    );

    const llmInputHandler = handlers.get("llm_input")!;
    llmInputHandler({ prompt: "Go for it" }, { runId: "r1", sessionId });

    await toolCallHandler(EXEC_EVENT, { sessionId, runId: "r1" });

    expect(capturedPrompt).toContain("1x IAU Jan 15, 2027 $100C");
    expect(capturedPrompt).toContain("Go for it");

    const row = readAuditRows().find((r) => r.phase === "before_tool_call");
    expect(row?.hadLastAssistantMessage).toBe(true);
    expect(row?.verdict).toBe("allow");
  });

  it("does not leak the last message across different sessions", async () => {
    let capturedPrompt = "";
    const complete = vi.fn(async (params: Record<string, unknown>) => {
      capturedPrompt = String((params as { messages: { content: string }[] }).messages[0]?.content ?? "");
      return { text: '{"verdict":"allow","reason":"fine"}' };
    });
    const { api, handlers } = makeApi(complete);
    registerReviewer(api, { auditDir, mode: "enforce", policyFile: policyPath });

    const finalizeHandler = handlers.get("before_agent_finalize")!;
    const toolCallHandler = handlers.get("before_tool_call")!;

    finalizeHandler({ sessionId: "session-A", lastAssistantMessage: "Confirm the IAU order?" }, {});
    await toolCallHandler(EXEC_EVENT, { sessionId: "session-B", runId: "r2" });

    expect(capturedPrompt).not.toContain("Confirm the IAU order");
    const row = readAuditRows().find((r) => r.phase === "before_tool_call");
    expect(row?.hadLastAssistantMessage).toBe(false);
  });

  it("is captured regardless of loop-guard mode (always-on registration)", async () => {
    delete process.env.OASIS_REVIEWER_LOOP_GUARD; // explicitly off
    let capturedPrompt = "";
    const complete = vi.fn(async (params: Record<string, unknown>) => {
      capturedPrompt = String((params as { messages: { content: string }[] }).messages[0]?.content ?? "");
      return { text: '{"verdict":"allow","reason":"fine"}' };
    });
    const { api, handlers } = makeApi(complete);
    registerReviewer(api, { auditDir, mode: "enforce", policyFile: policyPath });

    const finalizeHandler = handlers.get("before_agent_finalize")!;
    expect(finalizeHandler).toBeTypeOf("function"); // registered even with loop guard off

    finalizeHandler({ sessionId: "session-C", lastAssistantMessage: "Ready to proceed?" }, {});
    await handlers.get("before_tool_call")!(EXEC_EVENT, { sessionId: "session-C", runId: "r3" });

    expect(capturedPrompt).toContain("Ready to proceed?");
  });
});

describe("retryHint — Layer 1 static hints surface to the agent/operator", () => {
  it("appends the destructive-exec retry hint to blockReason on a deny", async () => {
    const { api, handlers } = makeApi();
    registerReviewer(api, { auditDir, mode: "enforce" }); // no policyFile needed — L1 only
    const handler = handlers.get("before_tool_call")!;

    const result = (await handler(
      { toolName: "exec", toolCallId: "t1", params: { command: "rm -rf /etc" } },
      { sessionId: "s1" },
    )) as { block?: boolean; blockReason?: string } | undefined;

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("safer retry:");
    expect(result?.blockReason).toMatch(/\/tmp/);
  });

  it("does not append a retry suffix when no hint exists (ordinary compound-exec escalate has none)", async () => {
    const { api, handlers } = makeApi();
    registerReviewer(api, { auditDir, mode: "enforce" });
    const handler = handlers.get("before_tool_call")!;

    const result = (await handler(
      { toolName: "exec", toolCallId: "t2", params: { command: "echo x > file" } },
      { sessionId: "s2" },
    )) as { requireApproval?: { description?: string } } | undefined;

    expect(result?.requireApproval?.description).toBeDefined();
    expect(result?.requireApproval?.description).not.toContain("safer retry");
    expect(result?.requireApproval?.description).not.toContain("retry now instead");
  });
});

describe("retryHint — Layer 2 model-generated hints surface to the agent/operator", () => {
  it("carries a Layer 2 retryHint through tightenOnly into blockReason on a tightened deny", async () => {
    const complete = vi.fn(async () => ({
      text: '{"verdict":"deny","principle":"TRADE-EXECUTION","reason":"no explicit approval visible","retryHint":"ask Mike to reply with the exact order details before retrying"}',
    }));
    const { api, handlers } = makeApi(complete);
    registerReviewer(api, { auditDir, mode: "enforce", policyFile: policyPath });
    const handler = handlers.get("before_tool_call")!;

    const result = (await handler(EXEC_EVENT, { sessionId: "s3", runId: "r4" })) as
      | { block?: boolean; blockReason?: string }
      | undefined;

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("ask Mike to reply with the exact order details");

    const row = readAuditRows().find((r) => r.phase === "before_tool_call");
    expect(row?.l2RetryHint).toBe("ask Mike to reply with the exact order details before retrying");
    expect(row?.retryHint).toBe("ask Mike to reply with the exact order details before retrying");
  });

  it("prefixes an escalate's retry hint distinctly from a deny's", async () => {
    const complete = vi.fn(async () => ({
      text: '{"verdict":"escalate","principle":"hard:operator-consent-action","reason":"needs Mike","retryHint":"or scope the write to /tmp instead"}',
    }));
    const { api, handlers } = makeApi(complete);
    registerReviewer(api, { auditDir, mode: "enforce", policyFile: policyPath });
    const handler = handlers.get("before_tool_call")!;

    const result = (await handler(EXEC_EVENT, { sessionId: "s4", runId: "r5" })) as
      | { requireApproval?: { description?: string } }
      | undefined;

    expect(result?.requireApproval?.description).toContain("retry now instead of waiting on approval");
    expect(result?.requireApproval?.description).toContain("or scope the write to /tmp instead");
  });

  it("omits the retry suffix when Layer 2 returns no retryHint", async () => {
    const complete = vi.fn(async () => ({
      text: '{"verdict":"deny","principle":"MALICE","reason":"this looks like an attack"}',
    }));
    const { api, handlers } = makeApi(complete);
    registerReviewer(api, { auditDir, mode: "enforce", policyFile: policyPath });
    const handler = handlers.get("before_tool_call")!;

    const result = (await handler(EXEC_EVENT, { sessionId: "s5", runId: "r6" })) as
      | { blockReason?: string }
      | undefined;

    expect(result?.blockReason).toBe("reviewer: this looks like an attack");
    expect(result?.blockReason).not.toContain("safer retry");
  });
});
