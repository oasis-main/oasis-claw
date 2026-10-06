import { describe, expect, it } from "vitest";
import { APPROVAL_DESCRIPTION_MAX, capApprovalDescription } from "./reviewer.js";

describe("capApprovalDescription", () => {
  const suffix = "\n(rule: hard:x, bot: house, tool: exec)";

  it("leaves a short description unchanged", () => {
    expect(capApprovalDescription("reason", suffix)).toBe(`reason${suffix}`);
  });

  it("keeps the rule line and fits the gateway's 512-char limit", () => {
    const out = capApprovalDescription("r".repeat(2000), suffix);
    expect(out.length).toBeLessThanOrEqual(APPROVAL_DESCRIPTION_MAX);
    expect(out.endsWith(suffix)).toBe(true);
    expect(out).toContain("…");
  });

  it("still fits when the retry hint alone is very long", () => {
    const out = capApprovalDescription("reason", `${suffix}\nIf you'd rather retry now: ${"h".repeat(1000)}`);
    expect(out.length).toBeLessThanOrEqual(APPROVAL_DESCRIPTION_MAX);
    expect(out.startsWith("reason")).toBe(true);
  });
});
