import { describe, expect, it } from "vitest";
import { buildJudgePrompt, type Layer2Input } from "./layer2.js";

// ── CLAW-103: standing task across a run boundary ────────────────────────────
// The judge's operatorRequest is scoped to one RUN. A failed or garbled turn
// ends that run, so the next run's own first prompt is a bare follow-up and the
// judge lost the work underway (confirmed twice in a deployment's audit log,
// 2026-08-14 and 2026-08-18). standingRequest carries the session's last
// substantive ask ALONGSIDE — never instead of — the run's own request.

const base: Layer2Input = {
  botKey: "example-bot",
  toolName: "exec",
  family: "exec",
  subject: "git stash",
  params: '{"command":"git stash"}',
  constitution: ["Serve Mike's intent."],
};

describe("buildJudgePrompt — standing request (CLAW-103)", () => {
  it("renders the standing task as its own labelled block", () => {
    const { user } = buildJudgePrompt({
      ...base,
      operatorRequest: "slop-cop check",
      standingRequest: "Verify the bedrock adapter fix and get the failing test green.",
    });
    expect(user).toContain("slop-cop check");
    expect(user).toContain("Verify the bedrock adapter fix");
    expect(user).toContain("STANDING TASK");
  });

  it("keeps the run's own request distinguishable from the standing task", () => {
    const { user } = buildJudgePrompt({
      ...base,
      operatorRequest: "slop-cop check",
      standingRequest: "Verify the bedrock adapter fix.",
    });
    // The run's own turn must still be presented as OPERATOR REQUEST, so the
    // judge can tell fresh intent from carried-forward context. Conflating the
    // two is what would let a stale ask manufacture consent.
    expect(user.indexOf("OPERATOR REQUEST")).toBeLessThan(user.indexOf("STANDING TASK"));
  });

  it("omits the block entirely when there is no standing task", () => {
    const { user } = buildJudgePrompt({ ...base, operatorRequest: "do the thing" });
    expect(user).not.toContain("STANDING TASK");
  });

  it("omits the block when it would only duplicate the run's request", () => {
    const same = "Verify the bedrock adapter fix.";
    const { user } = buildJudgePrompt({ ...base, operatorRequest: same, standingRequest: same });
    expect(user).not.toContain("STANDING TASK");
    // ...and the request itself still appears exactly once, so one ask cannot
    // read as two independent corroborating sources.
    expect(user.split(same).length - 1).toBe(1);
  });

  it("tells the judge the standing task is context, not fresh authorization", () => {
    const { system } = buildJudgePrompt({
      ...base,
      operatorRequest: "?",
      standingRequest: "Fix the adapter.",
    });
    expect(system).toContain("STANDING TASK");
    expect(system).toMatch(/NOT a fresh authorization/i);
  });
});
