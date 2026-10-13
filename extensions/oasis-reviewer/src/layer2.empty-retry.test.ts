import { describe, expect, it } from "vitest";
import { judgeConstitution, type LlmComplete } from "./layer2.js";

// 2026-10-13: an empty Layer 2 reply is retried ONCE inside the same deadline.
// Negative controls: a reply with text (even garbage) is not retried, two
// empty replies still give no verdict, and a timeout is not retried.

const INPUT = { botKey: "beta", toolName: "reach_send", family: "other", subject: "alpha", params: "{}", constitution: ["Serve Mike."] };
const ALLOW = '{"verdict":"allow","principle":"1"}';

function scripted(replies: Array<string | { delayMs: number }>) {
  let n = 0;
  const fn: LlmComplete = async (p) => {
    const r = replies[Math.min(n++, replies.length - 1)];
    if (typeof r === "string") return { text: r, usage: { output: r ? 12 : 3 } };
    await new Promise((res) => setTimeout(res, r.delayMs));
    return { text: p.signal?.aborted ? "" : ALLOW };
  };
  return { fn, calls: () => n };
}

describe("Layer 2 empty-reply retry", () => {
  it("retries one empty reply and uses the second answer", async () => {
    const m = scripted(["", ALLOW]);
    const r = await judgeConstitution(m.fn, INPUT, { timeoutMs: 2000 });
    expect(m.calls()).toBe(2);
    expect(r.decision?.verdict).toBe("allow");
    expect(r.emptyReplies).toBe(1);
    expect(r.emptyUsage).toEqual({ output: 3 });
  });

  it("NEGATIVE CONTROL: two empty replies still give no verdict (no third call)", async () => {
    const m = scripted(["", "", ALLOW]);
    const r = await judgeConstitution(m.fn, INPUT, { timeoutMs: 2000 });
    expect(m.calls()).toBe(2);
    expect(r.decision).toBeNull();
    expect(r.emptyReplies).toBe(2);
  });

  it("NEGATIVE CONTROL: a reply with text is not retried, even if it does not parse", async () => {
    const m = scripted(["not json", ALLOW]);
    const r = await judgeConstitution(m.fn, INPUT, { timeoutMs: 2000 });
    expect(m.calls()).toBe(1);
    expect(r.decision).toBeNull();
    expect(r.emptyReplies).toBeUndefined();
  });

  it("NEGATIVE CONTROL: a timeout is not retried", async () => {
    const m = scripted([{ delayMs: 300 }]);
    const r = await judgeConstitution(m.fn, INPUT, { timeoutMs: 100 });
    expect(m.calls()).toBe(1);
    expect(r.timedOut).toBe(true);
  });
});
