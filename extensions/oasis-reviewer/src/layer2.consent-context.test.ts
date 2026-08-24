import { describe, expect, it } from "vitest";
import { buildJudgePrompt, parseVerdict, type Layer2Input } from "./layer2.js";

// ── Generalized consent-context fix (2026-08-24) ─────────────────────────────
// Real incident: House proposed a specific trade order in full, Mike replied
// "Go for it", and the Layer 2 judge escalated it anyway — reasoning correctly
// over an INCOMPLETE picture, because operatorRequest/standingRequest only
// ever capture MIKE's own words, never what the bot itself just proposed. This
// generalizes the fix beyond trades: lastAssistantMessage lets the judge match
// a short reply to whatever it was actually confirming, for any tool call.

const base: Layer2Input = {
  botKey: "house",
  toolName: "exec",
  family: "exec",
  subject: "python3 place_iau_call.py",
  params: '{"command":"python3 place_iau_call.py"}',
  constitution: ["Serve Mike's intent."],
};

describe("buildJudgePrompt — bot's own last message (2026-08-24)", () => {
  it("renders the bot's last message as its own labelled block", () => {
    const { user } = buildJudgePrompt({
      ...base,
      operatorRequest: "Go for it",
      lastAssistantMessage: "Please confirm this exact order: 1x IAU Jan 15, 2027 $100C, buy-to-open limit $2.50, Day.",
    });
    expect(user).toContain("Go for it");
    expect(user).toContain("1x IAU Jan 15, 2027 $100C");
    expect(user).toContain("Bot's own last message");
  });

  it("omits the block entirely when no last message was captured", () => {
    const { user } = buildJudgePrompt({ ...base, operatorRequest: "Go for it" });
    expect(user).not.toContain("Bot's own last message");
  });

  it("tells the judge it is the bot's own words, not authorization by itself", () => {
    const { system } = buildJudgePrompt({
      ...base,
      operatorRequest: "yes",
      lastAssistantMessage: "Should I delete the old backups?",
    });
    expect(system).toContain("BOT'S OWN LAST MESSAGE");
    expect(system).toMatch(/NOT Mike's/i);
    expect(system).toMatch(/never authorization by itself/i);
  });

  it("instructs the judge to check the actual call matches what was described", () => {
    const { system } = buildJudgePrompt(base);
    expect(system).toMatch(/does the call you are judging actually match/i);
  });

  it("nonce-delimits the last message the same way as subject/params", () => {
    const { user, nonce } = buildJudgePrompt({
      ...base,
      lastAssistantMessage: "Confirm this order?",
    });
    const openers = user.split(`<<<UNTRUSTED_${nonce}>>>`).length - 1;
    // subject + params + lastAssistantMessage = three delimited blocks.
    expect(openers).toBe(3);
  });
});

describe("parseVerdict — retryHint (2026-08-24)", () => {
  it("extracts a retryHint when present", () => {
    const d = parseVerdict(
      '{"verdict":"deny","principle":"hard:x","reason":"looks risky","retryHint":"write it to a file first, then run it"}',
    );
    expect(d?.retryHint).toBe("write it to a file first, then run it");
  });

  it("omits retryHint entirely when absent (not an empty string)", () => {
    const d = parseVerdict('{"verdict":"allow","principle":"x","reason":"fine"}');
    expect(d).not.toHaveProperty("retryHint");
  });

  it("omits retryHint when the model sends an empty or whitespace string", () => {
    const d = parseVerdict('{"verdict":"deny","principle":"x","reason":"no","retryHint":"   "}');
    expect(d).not.toHaveProperty("retryHint");
  });

  it("caps retryHint length the same way reason is capped", () => {
    const long = "x".repeat(500);
    const d = parseVerdict(`{"verdict":"deny","principle":"x","reason":"no","retryHint":"${long}"}`);
    expect(d?.retryHint?.length).toBeLessThanOrEqual(300);
  });
});
