import { describe, expect, it } from "vitest";
import { buildJudgePrompt, parseVerdict, type Layer2Input } from "./layer2.js";

// ── "allow" carries no reason (2026-08-25, Mike's instruction) ───────────────
// "Can we perhaps instruct the auto-reviewer to not generate a reason or
// feedback if the request is approved, only if it is denied?"
//
// Most judged calls are allows, so the reason on an allow is written on the
// majority path and read by nobody. Dropping it cuts output tokens and
// latency there. A deny/escalate reason stays REQUIRED — it is the only
// explanation the bot or Mike ever sees for a call that did not happen.
//
// `principle` is deliberately KEPT on allow: it is a short id, costs almost
// nothing, and is what makes an allow row in reviewer-audit.jsonl traceable
// to the rule that permitted it. Losing that would blind the audit trail on
// the majority path, which is the exact class of invisible failure that hid
// the CLAW-106 outage.

const base: Layer2Input = {
  botKey: "nimbus",
  toolName: "exec",
  family: "exec",
  subject: "ls /reach/nimbus",
  params: '{"command":"ls /reach/nimbus"}',
  constitution: ["Serve Mike's intent."],
};

describe("buildJudgePrompt — allow is silent, deny explains", () => {
  it("instructs the judge to omit reason and retryHint on allow", () => {
    const { system } = buildJudgePrompt(base);
    expect(system).toMatch(/ON "allow", OMIT "reason" AND "retryHint" ENTIRELY/);
  });

  it("tells the judge not to substitute an empty string for the omitted keys", () => {
    const { system } = buildJudgePrompt(base);
    expect(system).toMatch(/leave the keys out/i);
  });

  it("keeps the reason REQUIRED on deny and escalate", () => {
    const { system } = buildJudgePrompt(base);
    expect(system).toMatch(/DENY or ESCALATE — a reason is REQUIRED/);
    expect(system).toMatch(/the ONLY explanation the bot and Mike ever see/);
  });

  it("still asks for principle on allow, so the audit row stays traceable", () => {
    const { system } = buildJudgePrompt(base);
    expect(system).toMatch(/\{"verdict":"allow","principle":/);
  });

  it("states plainly that omitting the reason must not change how carefully it decides", () => {
    const { system } = buildJudgePrompt(base);
    expect(system).toMatch(/does NOT change how carefully you decide/i);
  });
});

describe("parseVerdict — accepts a bare allow", () => {
  it("parses an allow with no reason and no retryHint", () => {
    const d = parseVerdict('{"verdict":"allow","principle":"PRIME DIRECTIVE"}');
    expect(d).toMatchObject({ verdict: "allow", principle: "PRIME DIRECTIVE", reason: "" });
    expect(d).not.toHaveProperty("retryHint");
  });

  it("parses an allow with only a verdict", () => {
    const d = parseVerdict('{"verdict":"allow"}');
    expect(d).toMatchObject({ verdict: "allow", reason: "" });
  });

  it("still parses a deny that carries reason and retryHint", () => {
    const d = parseVerdict(
      '{"verdict":"deny","principle":"MALICE","reason":"looks like exfiltration","retryHint":"scope the read to one file"}',
    );
    expect(d).toMatchObject({
      verdict: "deny",
      principle: "MALICE",
      reason: "looks like exfiltration",
      retryHint: "scope the read to one file",
    });
  });

  it("does not reject an allow that still includes a reason (older judges / drift)", () => {
    // Backward compatibility: the instruction is a prompt, not a schema gate.
    // A judge that keeps sending a reason must still parse, not fail closed —
    // on a constitutionalReviewRequired bot an unparseable verdict is a DENY.
    const d = parseVerdict('{"verdict":"allow","principle":"X","reason":"still explaining"}');
    expect(d).toMatchObject({ verdict: "allow", reason: "still explaining" });
  });
});
