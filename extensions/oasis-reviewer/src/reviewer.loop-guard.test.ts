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
  delete process.env.OASIS_REVIEWER_LOOP_GUARD_TRANSIENT_THRESHOLD;
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
  // 2026-08-24: before_agent_finalize is now ALWAYS registered — it also
  // captures the bot's own last message for Layer 2's consent-context fix
  // (see reviewer.consent-context.test.ts), which every bot needs regardless
  // of loop-guard mode. What must still hold with the loop guard off is its
  // OWN behavior: no loop_guard audit row and no action, even past a repeat
  // streak that would trip enforce mode.
  it("registers before_agent_finalize (for capture) but takes no loop-guard action when OASIS_REVIEWER_LOOP_GUARD is unset", () => {
    delete process.env.OASIS_REVIEWER_LOOP_GUARD;
    const { api, handlers } = makeApi();
    registerReviewer(api, { auditDir, mode: "shadow" });
    expect(handlers.has("before_agent_finalize")).toBe(true);

    const handler = handlers.get("before_agent_finalize")!;
    const sessionId = "loop-guard-off-session";
    const text = "the same reply, over and over";
    let result: unknown;
    for (let i = 0; i < 5; i++) {
      result = handler({ sessionId, lastAssistantMessage: text }, {});
    }
    expect(result).toBeUndefined();
    expect(readAuditRows().filter((r) => r.phase === "loop_guard")).toHaveLength(0);
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

// ── CLAW-089: near-identical matching + transient-retry tolerance ────────────
// The guard used to hash normalized text and compare it for EXACT equality, so
// any changed character read as a brand-new reply. The 2026-08-13 incident was
// "near-identical" replies, which that guard would very likely never have caught.
describe("loop guard — near-identical replies (CLAW-089)", () => {
  const enforce = (threshold: string) => {
    process.env.OASIS_REVIEWER_LOOP_GUARD = "enforce";
    process.env.OASIS_REVIEWER_LOOP_GUARD_THRESHOLD = threshold;
    const { api, handlers } = makeApi();
    registerReviewer(api, { auditDir, mode: "shadow" });
    return handlers.get("before_agent_finalize")!;
  };

  it("catches a retry that only changes the attempt number", () => {
    const handler = enforce("3");
    const sessionId = "near-attempt";
    for (const n of [1, 2]) {
      expect(handler({ sessionId, lastAssistantMessage: `Retrying the deploy (attempt ${n}). Still waiting on the build.` }, {})).toBeUndefined();
    }
    const third = handler({ sessionId, lastAssistantMessage: "Retrying the deploy (attempt 3). Still waiting on the build." }, {}) as { action?: string } | undefined;
    expect(third?.action).toBe("finalize");
  });

  it("catches a retry that only restamps the time", () => {
    const handler = enforce("2");
    const sessionId = "near-ts";
    expect(handler({ sessionId, lastAssistantMessage: "Checked at 2026-09-01T10:00:00Z — nothing new to report." }, {})).toBeUndefined();
    const second = handler({ sessionId, lastAssistantMessage: "Checked at 2026-09-01T10:05:31Z — nothing new to report." }, {}) as { action?: string } | undefined;
    expect(second?.action).toBe("finalize");
  });

  it("does NOT fire on genuine progress, even when the replies share a lot of wording", () => {
    const handler = enforce("2");
    const sessionId = "progress";
    expect(handler({ sessionId, lastAssistantMessage: "The build failed on the lint step. I am going to read the lint config now." }, {})).toBeUndefined();
    const second = handler(
      { sessionId, lastAssistantMessage: "The lint config sets no-floating-promises. I am adding an await in reach-send.ts and rerunning." },
      {},
    ) as { action?: string } | undefined;
    expect(second?.action).toBeUndefined();
  });
});

describe("loop guard — transient-retry tolerance (CLAW-089)", () => {
  // Mike, 2026-09-01: repeating yourself while the network or the model API is
  // flapping is CORRECT behaviour. It gets a HIGHER threshold, not an exemption —
  // past that point the cause is a blocker to report, not something to retry.
  const enforce = (threshold: string, transientThreshold: string) => {
    process.env.OASIS_REVIEWER_LOOP_GUARD = "enforce";
    process.env.OASIS_REVIEWER_LOOP_GUARD_THRESHOLD = threshold;
    process.env.OASIS_REVIEWER_LOOP_GUARD_TRANSIENT_THRESHOLD = transientThreshold;
    const { api, handlers } = makeApi();
    registerReviewer(api, { auditDir, mode: "shadow" });
    return handlers.get("before_agent_finalize")!;
  };

  const NET = "Connection reset by peer while calling the API. Retrying.";

  it("tolerates a transient-cause repeat past the ordinary threshold", () => {
    const handler = enforce("2", "5");
    const sessionId = "transient-rope";
    // Ordinary threshold is 2; these would have stopped at the 2nd without tolerance.
    for (let i = 0; i < 4; i++) {
      expect(handler({ sessionId, lastAssistantMessage: NET }, {}), `attempt ${i + 1}`).toBeUndefined();
    }
  });

  it("still stops once the transient threshold is reached — rope, not an exemption", () => {
    const handler = enforce("2", "5");
    const sessionId = "transient-stops";
    for (let i = 0; i < 4; i++) handler({ sessionId, lastAssistantMessage: NET }, {});
    const fifth = handler({ sessionId, lastAssistantMessage: NET }, {}) as { action?: string; reason?: string } | undefined;
    expect(fifth?.action).toBe("finalize");
    expect(fifth?.reason).toContain("blocker");
  });

  it("records both thresholds in the audit so shadow mode explains the tolerance", () => {
    const handler = enforce("2", "5");
    const sessionId = "transient-audit";
    for (let i = 0; i < 5; i++) handler({ sessionId, lastAssistantMessage: NET }, {});
    const rows = readAuditRows().filter((r) => r.phase === "loop_guard");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ streak: 5, threshold: 5, ordinaryThreshold: 2, transient: true });
  });

  it("cannot buy extra rope by naming a transient cause only AFTER the streak started", () => {
    // The streak is transient only if EVERY reply in it names a transient cause,
    // including the first. Otherwise a stuck bot could unlock the longer
    // threshold mid-loop just by mentioning a timeout.
    const handler = enforce("2", "9");
    const sessionId = "transient-late-claim";
    handler({ sessionId, lastAssistantMessage: "Still working on the same step. Nothing to report yet." }, {});
    const second = handler(
      { sessionId, lastAssistantMessage: "Still working on the same step. Nothing to report yet. Connection reset." },
      {},
    ) as { action?: string } | undefined;
    expect(second?.action).toBe("finalize");
  });

  it("never lets the transient threshold be configured BELOW the ordinary one", () => {
    const handler = enforce("4", "2"); // transient deliberately lower than ordinary
    const sessionId = "transient-floor";
    for (let i = 0; i < 3; i++) {
      expect(handler({ sessionId, lastAssistantMessage: NET }, {}), `attempt ${i + 1}`).toBeUndefined();
    }
    const fourth = handler({ sessionId, lastAssistantMessage: NET }, {}) as { action?: string } | undefined;
    expect(fourth?.action).toBe("finalize");
  });
});
