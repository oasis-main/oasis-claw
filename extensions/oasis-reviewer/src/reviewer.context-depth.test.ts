import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerReviewer } from "./reviewer.js";

// ── "Sound | Initial Request" / "Sound | Recent Conversation" /
//    "Sound | Full Trajectory" (2026-08-24) ───────────────────────────────
// Mike: "the reviewer needs to be able to see the entire session history/
// trajectory to analyze it... this is not our first session addressing it.
// making this configurable... is likely wise." Three progressively deeper
// (and progressively more expensive) context tiers, dialed via
// OASIS_REVIEWER_CONTEXT_DEPTH = initial | recent | full. Default is
// "recent" — the shape already shipped fleet-wide earlier the same day —
// so introducing this dial changes nobody's behavior until a bot is
// explicitly moved to a different tier.

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function makeApi(
  completeImpl?: (params: Record<string, unknown>) => Promise<{ text: string }>,
  sessionImpl?: { resolveSessionFilePath: (sessionId: string, entry?: unknown, opts?: unknown) => string },
) {
  const handlers = new Map<string, Handler>();
  return {
    api: {
      on: (name: string, handler: Handler) => {
        handlers.set(name, handler);
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      pluginConfig: {},
      runtime: completeImpl
        ? { llm: { complete: completeImpl }, session: sessionImpl }
        : undefined,
    } as unknown as Parameters<typeof registerReviewer>[0],
    handlers,
  };
}

let tmpDir: string;
let auditDir: string;
let policyPath: string;

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

function writeSessionFile(name: string, lines: unknown[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-reviewer-context-depth-test-"));
  auditDir = path.join(tmpDir, "logs", "reviewer");
  policyPath = writePolicy();
  process.env.OASIS_REVIEWER_L2 = "enforce";
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.OASIS_REVIEWER_L2;
  delete process.env.OASIS_REVIEWER_CONTEXT_DEPTH;
  delete process.env.OASIS_REVIEWER_CONTEXT_MAX_CHARS;
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

describe("context depth — default is 'recent' (unchanged behavior)", () => {
  it("defaults to recent when OASIS_REVIEWER_CONTEXT_DEPTH is unset", async () => {
    delete process.env.OASIS_REVIEWER_CONTEXT_DEPTH;
    let capturedPrompt = "";
    const complete = vi.fn(async (params: Record<string, unknown>) => {
      capturedPrompt = String((params as { messages: { content: string }[] }).messages[0]?.content ?? "");
      return { text: '{"verdict":"allow","reason":"fine"}' };
    });
    const { api, handlers } = makeApi(complete);
    registerReviewer(api, { auditDir, mode: "enforce", policyFile: policyPath });

    handlers.get("before_agent_finalize")!({ sessionId: "s1", lastAssistantMessage: "Confirm this order?" }, {});
    await handlers.get("before_tool_call")!(EXEC_EVENT, { sessionId: "s1", runId: "r1" });

    expect(capturedPrompt).toContain("Confirm this order?");
    expect(capturedPrompt).not.toContain("FULL SESSION TRAJECTORY");
    const row = readAuditRows().find((r) => r.phase === "before_tool_call");
    expect(row?.contextDepth).toBe("recent");
    expect(row?.hadLastAssistantMessage).toBe(true);
    expect(row?.hadSessionTranscript).toBe(false);
  });

  it("falls back to recent on an unrecognized value", async () => {
    process.env.OASIS_REVIEWER_CONTEXT_DEPTH = "bogus-value";
    const { api, handlers } = makeApi(vi.fn(async () => ({ text: '{"verdict":"allow","reason":"fine"}' })));
    registerReviewer(api, { auditDir, mode: "enforce", policyFile: policyPath });
    await handlers.get("before_tool_call")!(EXEC_EVENT, { sessionId: "s2", runId: "r2" });
    const row = readAuditRows().find((r) => r.phase === "before_tool_call");
    expect(row?.contextDepth).toBe("recent");
  });
});

describe("context depth — 'initial' (Sound | Initial Request)", () => {
  it("passes only operatorRequest — no standing task, no last message, even when both were captured", async () => {
    process.env.OASIS_REVIEWER_CONTEXT_DEPTH = "initial";
    let capturedPrompt = "";
    const complete = vi.fn(async (params: Record<string, unknown>) => {
      capturedPrompt = String((params as { messages: { content: string }[] }).messages[0]?.content ?? "");
      return { text: '{"verdict":"allow","reason":"fine"}' };
    });
    const { api, handlers } = makeApi(complete);
    registerReviewer(api, { auditDir, mode: "enforce", policyFile: policyPath });

    handlers.get("before_agent_finalize")!({ sessionId: "s3", lastAssistantMessage: "Confirm the IAU order?" }, {});
    const llmInputHandler = handlers.get("llm_input")!;
    llmInputHandler({ prompt: "A".repeat(200) }, { runId: "r-prev", sessionId: "s3" }); // long enough to become standing
    llmInputHandler({ prompt: "Go for it" }, { runId: "r3", sessionId: "s3" });

    await handlers.get("before_tool_call")!(EXEC_EVENT, { sessionId: "s3", runId: "r3" });

    expect(capturedPrompt).toContain("Go for it");
    expect(capturedPrompt).not.toContain("Confirm the IAU order");
    expect(capturedPrompt).not.toContain("A".repeat(200));
    expect(capturedPrompt).not.toContain("STANDING TASK");
    expect(capturedPrompt).not.toContain("Bot's own last message");

    const row = readAuditRows().find((r) => r.phase === "before_tool_call");
    expect(row?.contextDepth).toBe("initial");
    expect(row?.hadStandingRequest).toBe(false);
    expect(row?.hadLastAssistantMessage).toBe(false);
  });
});

describe("context depth — 'full' (Sound | Full Trajectory)", () => {
  it("reads the session transcript via runtime.session.resolveSessionFilePath and includes it in the prompt", async () => {
    process.env.OASIS_REVIEWER_CONTEXT_DEPTH = "full";
    const sessionFile = writeSessionFile("real-session.jsonl", [
      { type: "session", id: "sess-1" },
      { type: "message", message: { role: "user", content: "Please confirm this exact order: 1x IAU $100C." } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Confirmed, placing it now." }] } },
    ]);
    const resolveSessionFilePath = vi.fn((sid: string) => {
      expect(sid).toBe("s4");
      return sessionFile;
    });

    let capturedPrompt = "";
    const complete = vi.fn(async (params: Record<string, unknown>) => {
      capturedPrompt = String((params as { messages: { content: string }[] }).messages[0]?.content ?? "");
      return { text: '{"verdict":"allow","reason":"matches the trajectory"}' };
    });
    const { api, handlers } = makeApi(complete, { resolveSessionFilePath });
    registerReviewer(api, { auditDir, mode: "enforce", policyFile: policyPath });

    await handlers.get("before_tool_call")!(EXEC_EVENT, { sessionId: "s4", runId: "r4", agentId: "main" });

    expect(resolveSessionFilePath).toHaveBeenCalledWith("s4", undefined, { agentId: "main" });
    expect(capturedPrompt).toContain("FULL SESSION TRAJECTORY");
    expect(capturedPrompt).toContain("1x IAU $100C");
    expect(capturedPrompt).toContain("Confirmed, placing it now");

    const row = readAuditRows().find((r) => r.phase === "before_tool_call");
    expect(row?.contextDepth).toBe("full");
    expect(row?.hadSessionTranscript).toBe(true);
    expect(row?.sessionTranscriptTruncated).toBe(false);
  });

  it("marks truncation in the audit row when the transcript exceeds the char budget", async () => {
    process.env.OASIS_REVIEWER_CONTEXT_DEPTH = "full";
    process.env.OASIS_REVIEWER_CONTEXT_MAX_CHARS = "50";
    const lines = Array.from({ length: 20 }, (_, i) => ({
      type: "message",
      message: { role: "user", content: `turn number ${i}` },
    }));
    const sessionFile = writeSessionFile("long-session.jsonl", lines);
    const resolveSessionFilePath = vi.fn(() => sessionFile);

    const complete = vi.fn(async () => ({ text: '{"verdict":"allow","reason":"fine"}' }));
    const { api, handlers } = makeApi(complete, { resolveSessionFilePath });
    registerReviewer(api, { auditDir, mode: "enforce", policyFile: policyPath });

    await handlers.get("before_tool_call")!(EXEC_EVENT, { sessionId: "s5", runId: "r5" });

    const row = readAuditRows().find((r) => r.phase === "before_tool_call");
    expect(row?.sessionTranscriptTruncated).toBe(true);
  });

  it("degrades to the 'recent' fields when the transcript read fails (missing file)", async () => {
    process.env.OASIS_REVIEWER_CONTEXT_DEPTH = "full";
    const resolveSessionFilePath = vi.fn(() => path.join(tmpDir, "does-not-exist.jsonl"));

    let capturedPrompt = "";
    const complete = vi.fn(async (params: Record<string, unknown>) => {
      capturedPrompt = String((params as { messages: { content: string }[] }).messages[0]?.content ?? "");
      return { text: '{"verdict":"allow","reason":"fine"}' };
    });
    const { api, handlers } = makeApi(complete, { resolveSessionFilePath });
    registerReviewer(api, { auditDir, mode: "enforce", policyFile: policyPath });

    handlers.get("before_agent_finalize")!({ sessionId: "s6", lastAssistantMessage: "Confirm the fallback order?" }, {});
    await handlers.get("before_tool_call")!(EXEC_EVENT, { sessionId: "s6", runId: "r6" });

    // Transcript read produced nothing (file doesn't exist) — falls back to
    // the recent-tier field instead of judging with zero context.
    expect(capturedPrompt).not.toContain("FULL SESSION TRAJECTORY");
    expect(capturedPrompt).toContain("Confirm the fallback order?");

    const row = readAuditRows().find((r) => r.phase === "before_tool_call");
    expect(row?.hadSessionTranscript).toBe(false);
    expect(row?.hadLastAssistantMessage).toBe(true);
  });

  it("does not attempt a transcript read for a call that will never reach Layer 2", async () => {
    process.env.OASIS_REVIEWER_CONTEXT_DEPTH = "full";
    const resolveSessionFilePath = vi.fn(() => path.join(tmpDir, "unused.jsonl"));
    const complete = vi.fn(async () => ({ text: '{"verdict":"allow","reason":"fine"}' }));
    const { api, handlers } = makeApi(complete, { resolveSessionFilePath });
    // No policyFile this time — empty constitution means needsConstitution
    // (and therefore l2Eligible) is false, so the transcript read must be
    // skipped entirely rather than paying disk I/O for nothing.
    registerReviewer(api, { auditDir, mode: "enforce" });

    await handlers.get("before_tool_call")!(EXEC_EVENT, { sessionId: "s7", runId: "r7" });

    expect(resolveSessionFilePath).not.toHaveBeenCalled();
  });
});
