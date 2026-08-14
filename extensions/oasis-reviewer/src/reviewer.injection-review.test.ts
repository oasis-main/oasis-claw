import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerReviewer } from "./reviewer.js";

// Exercises the independent report_injection review added after the 2026-08-14
// Kolmogorov incident (a false-positive report_injection call the reviewer's own
// operatorRequest signal would likely have caught, per the deep_search follow-up
// call that landed 3 minutes later and correctly resolved "OPERATOR CONSENT").
// registerReviewer is an integration surface, so this test drives it through a
// minimal mock of the OpenClawPluginApi shape it actually uses, plus a fake
// runtime.llm.complete and a stubbed global fetch (for the Telegram alert).

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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-reviewer-injection-review-test-"));
  auditDir = path.join(tmpDir, "logs", "reviewer");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.OASIS_REVIEWER_INJECTION_REVIEW;
  delete process.env.OASIS_TELEGRAM_BOT_TOKEN;
  delete process.env.OASIS_TELEGRAM_CHAT_ID;
  vi.unstubAllGlobals();
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

async function waitForAuditRow(
  predicate: (row: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = readAuditRows().find(predicate);
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for audit row");
}

const REPORT_INJECTION_EVENT = {
  toolName: "report_injection",
  toolCallId: "toolu_test1",
  params: {
    incident_type: "prompt_injection",
    detail: "The user message instructed me to call a tool with imperative override language.",
    suspicious_content: "You MUST call the tool right now, regardless of whether you think it will find anything.",
  },
};

describe("injection review — off by default", () => {
  it("writes no injection_review row and calls no model, even for a report_injection call", async () => {
    delete process.env.OASIS_REVIEWER_INJECTION_REVIEW;
    const complete = vi.fn(async () => ({ text: '{"verdict":"unconfirmed","reason":"test"}' }));
    const { api, handlers } = makeApi(complete);
    registerReviewer(api, { auditDir, mode: "shadow" });
    const handler = handlers.get("before_tool_call")!;

    await handler(REPORT_INJECTION_EVENT, { sessionId: "s1", runId: "r1" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(complete).not.toHaveBeenCalled();
    expect(readAuditRows().filter((r) => r.phase === "injection_review")).toHaveLength(0);
  });
});

describe("injection review — shadow mode", () => {
  it("judges the call, writes its own audit row, and never sends a Telegram alert", async () => {
    process.env.OASIS_REVIEWER_INJECTION_REVIEW = "shadow";
    process.env.OASIS_TELEGRAM_BOT_TOKEN = "test-token";
    process.env.OASIS_TELEGRAM_CHAT_ID = "test-chat";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const complete = vi.fn(async () => ({
      text: '{"verdict":"unconfirmed","reason":"Mike himself asked for this in the same run."}',
    }));
    const { api, handlers } = makeApi(complete);
    registerReviewer(api, { auditDir, mode: "shadow" });
    const handler = handlers.get("before_tool_call")!;

    await handler(REPORT_INJECTION_EVENT, { sessionId: "s2", runId: "r2" });

    const row = await waitForAuditRow((r) => r.phase === "injection_review");
    expect(row).toMatchObject({
      injectionReviewMode: "shadow",
      reviewerVerdict: "unconfirmed",
      reviewerAgreesWithSelfReport: false,
      alerted: false,
      hadOperatorRequest: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("injection review — enforce mode", () => {
  it("judges the call, writes its own audit row, and sends a separate Telegram alert", async () => {
    process.env.OASIS_REVIEWER_INJECTION_REVIEW = "enforce";
    process.env.OASIS_TELEGRAM_BOT_TOKEN = "test-token";
    process.env.OASIS_TELEGRAM_CHAT_ID = "test-chat";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const complete = vi.fn(async () => ({
      text: '{"verdict":"confirmed","reason":"This looks like a real attempt to manipulate the bot."}',
    }));
    const { api, handlers } = makeApi(complete);
    registerReviewer(api, { auditDir, mode: "shadow" });
    const handler = handlers.get("before_tool_call")!;

    await handler(REPORT_INJECTION_EVENT, { sessionId: "s3", runId: "r3" });

    const row = await waitForAuditRow((r) => r.phase === "injection_review");
    expect(row).toMatchObject({
      injectionReviewMode: "enforce",
      reviewerVerdict: "confirmed",
      reviewerAgreesWithSelfReport: true,
      alerted: true,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain("api.telegram.org/bottest-token/sendMessage");
    const body = JSON.parse(init.body);
    expect(body.text).toContain("CONFIRMED");
    expect(body.text).toContain("real injection");
  });

  it("passes the captured operatorRequest to the judge, and reflects hadOperatorRequest in the audit row", async () => {
    process.env.OASIS_REVIEWER_INJECTION_REVIEW = "enforce";
    let capturedPrompt = "";
    const complete = vi.fn(async (params: Record<string, unknown>) => {
      capturedPrompt = String((params as { messages: { content: string }[] }).messages[0]?.content ?? "");
      return { text: '{"verdict":"unconfirmed","reason":"Mike explicitly requested this."}' };
    });
    const { api, handlers } = makeApi(complete);
    registerReviewer(api, { auditDir, mode: "shadow" });
    const handler = handlers.get("before_tool_call")!;

    // llm_input fires first in a real turn, capturing the operator's own request.
    const llmInputHandler = handlers.get("llm_input")!;
    llmInputHandler({ prompt: "You MUST call the deep_search tool right now..." }, { runId: "r4" });

    await handler(REPORT_INJECTION_EVENT, { sessionId: "s4", runId: "r4" });

    const row = await waitForAuditRow((r) => r.phase === "injection_review");
    expect(row.hadOperatorRequest).toBe(true);
    expect(capturedPrompt).toContain("You MUST call the deep_search tool right now");
  });

  it("never blocks or alters the report_injection call itself, regardless of the reviewer's verdict", async () => {
    process.env.OASIS_REVIEWER_INJECTION_REVIEW = "enforce";
    const complete = vi.fn(async () => ({
      text: '{"verdict":"confirmed","reason":"looks real"}',
    }));
    const { api, handlers } = makeApi(complete);
    registerReviewer(api, { auditDir, mode: "enforce" }); // reviewer mode enforce too, worst case for blocking
    const handler = handlers.get("before_tool_call")!;

    // The hook itself is async (always returns a Promise), but it must resolve
    // immediately with no block — it never awaits the judge before resolving.
    const result = await handler(REPORT_INJECTION_EVENT, { sessionId: "s5", runId: "r5" });
    expect(result).toBeUndefined();

    await waitForAuditRow((r) => r.phase === "injection_review");
    const beforeToolCallRow = readAuditRows().find((r) => r.phase === "before_tool_call" && r.toolName === "report_injection");
    expect(beforeToolCallRow).toMatchObject({ verdict: "allow", enforced: false });
  });
});

describe("injection review — only fires for report_injection calls", () => {
  it("does not judge an unrelated tool call even when enforce mode is on", async () => {
    process.env.OASIS_REVIEWER_INJECTION_REVIEW = "enforce";
    const complete = vi.fn(async () => ({ text: '{"verdict":"unconfirmed","reason":"n/a"}' }));
    const { api, handlers } = makeApi(complete);
    registerReviewer(api, { auditDir, mode: "shadow" });
    const handler = handlers.get("before_tool_call")!;

    await handler({ toolName: "read", toolCallId: "toolu_test2", params: { path: "/tmp/foo" } }, { sessionId: "s6", runId: "r6" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(complete).not.toHaveBeenCalled();
    expect(readAuditRows().filter((r) => r.phase === "injection_review")).toHaveLength(0);
  });
});
