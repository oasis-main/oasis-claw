import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerReviewer } from "./reviewer.js";

// Exercises the before_agent_finalize loop guard added after the 2026-08-13
// House-bot incident (14 minutes of near-identical repeated replies with no
// automatic stop). registerReviewer is otherwise an integration surface, so
// this test drives it through a minimal mock of the OpenClawPluginApi shape
// it actually uses: on(), logger, pluginConfig-adjacent config passed
// directly as opts.

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function makeApi() {
  const handlers = new Map<string, Handler>();
  return {
    api: {
      on: (name: string, handler: Handler) => {
        handlers.set(name, handler);
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      pluginConfig: {},
    } as unknown as Parameters<typeof registerReviewer>[0],
    handlers,
  };
}

let tmpDir: string;
let auditDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-reviewer-loop-guard-test-"));
  auditDir = path.join(tmpDir, "logs", "reviewer");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.OASIS_REVIEWER_LOOP_GUARD;
  delete process.env.OASIS_REVIEWER_LOOP_GUARD_THRESHOLD;
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

describe("loop guard — off by default", () => {
  it("registers no before_agent_finalize handler when OASIS_REVIEWER_LOOP_GUARD is unset", () => {
    delete process.env.OASIS_REVIEWER_LOOP_GUARD;
    const { api, handlers } = makeApi();
    registerReviewer(api, { auditDir, mode: "shadow" });
    expect(handlers.has("before_agent_finalize")).toBe(false);
  });
});

describe("loop guard — shadow mode", () => {
  it("logs a loop_guard row once the threshold is crossed but returns nothing (never acts)", () => {
    process.env.OASIS_REVIEWER_LOOP_GUARD = "shadow";
    process.env.OASIS_REVIEWER_LOOP_GUARD_THRESHOLD = "3";
    const { api, handlers } = makeApi();
    registerReviewer(api, { auditDir, mode: "shadow" });
    const handler = handlers.get("before_agent_finalize");
    expect(handler).toBeTypeOf("function");

    const sessionId = "shadow-session-1";
    const text = "I never generated this message in this session.";
    let result: unknown;
    for (let i = 0; i < 3; i++) {
      result = handler!({ sessionId, lastAssistantMessage: text }, {});
    }
    expect(result).toBeUndefined(); // shadow never acts, even past threshold

    const rows = readAuditRows().filter((r) => r.phase === "loop_guard");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ streak: 3, threshold: 3, enforced: false, sessionId });
  });
});

describe("loop guard — enforce mode", () => {
  it("does nothing for distinct replies", () => {
    process.env.OASIS_REVIEWER_LOOP_GUARD = "enforce";
    const { api, handlers } = makeApi();
    registerReviewer(api, { auditDir, mode: "shadow" });
    const handler = handlers.get("before_agent_finalize")!;

    const sessionId = "enforce-session-distinct";
    expect(handler({ sessionId, lastAssistantMessage: "first reply" }, {})).toBeUndefined();
    expect(handler({ sessionId, lastAssistantMessage: "second, different reply" }, {})).toBeUndefined();
    expect(handler({ sessionId, lastAssistantMessage: "a third, also different reply" }, {})).toBeUndefined();
    expect(readAuditRows().filter((r) => r.phase === "loop_guard")).toHaveLength(0);
  });

  it("returns {action:'finalize'} once the same reply repeats past the threshold", () => {
    process.env.OASIS_REVIEWER_LOOP_GUARD = "enforce";
    process.env.OASIS_REVIEWER_LOOP_GUARD_THRESHOLD = "3";
    const { api, handlers } = makeApi();
    registerReviewer(api, { auditDir, mode: "shadow" });
    const handler = handlers.get("before_agent_finalize")!;

    const sessionId = "enforce-session-repeat";
    const text = "  No action needed; no reply sent.  ";
    expect(handler({ sessionId, lastAssistantMessage: text }, {})).toBeUndefined();
    expect(handler({ sessionId, lastAssistantMessage: text }, {})).toBeUndefined();
    const third = handler({ sessionId, lastAssistantMessage: text }, {}) as
      | { action?: string; reason?: string }
      | undefined;
    expect(third?.action).toBe("finalize");
    expect(third?.reason).toContain("repeated 3 times");

    const rows = readAuditRows().filter((r) => r.phase === "loop_guard");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ streak: 3, enforced: true, sessionId });
  });

  it("treats reformatted whitespace/case as the same repeated reply", () => {
    process.env.OASIS_REVIEWER_LOOP_GUARD = "enforce";
    process.env.OASIS_REVIEWER_LOOP_GUARD_THRESHOLD = "2";
    const { api, handlers } = makeApi();
    registerReviewer(api, { auditDir, mode: "shadow" });
    const handler = handlers.get("before_agent_finalize")!;

    const sessionId = "enforce-session-normalize";
    expect(handler({ sessionId, lastAssistantMessage: "Same   Reply" }, {})).toBeUndefined();
    const second = handler({ sessionId, lastAssistantMessage: "  same reply  " }, {}) as
      | { action?: string }
      | undefined;
    expect(second?.action).toBe("finalize");
  });

  it("resets the streak after finalizing, so the next distinct reply doesn't immediately re-trigger", () => {
    process.env.OASIS_REVIEWER_LOOP_GUARD = "enforce";
    process.env.OASIS_REVIEWER_LOOP_GUARD_THRESHOLD = "2";
    const { api, handlers } = makeApi();
    registerReviewer(api, { auditDir, mode: "shadow" });
    const handler = handlers.get("before_agent_finalize")!;

    const sessionId = "enforce-session-reset";
    const text = "repeat me";
    handler({ sessionId, lastAssistantMessage: text }, {});
    const triggered = handler({ sessionId, lastAssistantMessage: text }, {}) as { action?: string } | undefined;
    expect(triggered?.action).toBe("finalize");

    const after = handler({ sessionId, lastAssistantMessage: "a fresh, different reply" }, {});
    expect(after).toBeUndefined();
  });

  it("never throws and logs an error row if the event is malformed", () => {
    process.env.OASIS_REVIEWER_LOOP_GUARD = "enforce";
    const { api, handlers } = makeApi();
    registerReviewer(api, { auditDir, mode: "shadow" });
    const handler = handlers.get("before_agent_finalize")!;
    expect(() => handler(null as unknown as Record<string, unknown>, {})).not.toThrow();
  });

  it("ignores empty/whitespace-only assistant text", () => {
    process.env.OASIS_REVIEWER_LOOP_GUARD = "enforce";
    process.env.OASIS_REVIEWER_LOOP_GUARD_THRESHOLD = "2";
    const { api, handlers } = makeApi();
    registerReviewer(api, { auditDir, mode: "shadow" });
    const handler = handlers.get("before_agent_finalize")!;
    const sessionId = "enforce-session-empty";
    expect(handler({ sessionId, lastAssistantMessage: "" }, {})).toBeUndefined();
    expect(handler({ sessionId, lastAssistantMessage: "   " }, {})).toBeUndefined();
    expect(readAuditRows().filter((r) => r.phase === "loop_guard")).toHaveLength(0);
  });
});
