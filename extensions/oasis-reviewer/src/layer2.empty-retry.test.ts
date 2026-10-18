import { describe, expect, it } from "vitest";
import { judgeConstitution, judgeFailureCause, type LlmComplete } from "./layer2.js";

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

// 2026-10-18: Nimbus lost 4 reach_send calls on 2026-10-17 to two empty
// replies each. The deny said "unparseable verdict"; a replay through Bedrock
// showed stopReason content_filtered and 0 output tokens. The finish reason of
// the empty reply now reaches the result, the audit and the deny wording.
describe("Layer 2 empty-reply finish reason", () => {
  const filtered: LlmComplete = async () => ({
    text: "",
    usage: { output: 0 },
    stopReason: "error",
    errorMessage: "Provider finish_reason: content_filter",
  });

  it("records the finish reason and error message of the empty reply", async () => {
    const r = await judgeConstitution(filtered, INPUT, { timeoutMs: 2000 });
    expect(r.decision).toBeNull();
    expect(r.emptyReplies).toBe(2);
    expect(r.emptyFinishReason).toBe("error");
    expect(r.emptyErrorMessage).toBe("Provider finish_reason: content_filter");
  });

  it("names an empty reply, not an unparseable verdict, in the deny cause", async () => {
    const r = await judgeConstitution(filtered, INPUT, { timeoutMs: 2000 });
    expect(judgeFailureCause(r)).toBe(
      "judge returned an empty reply 2 times, finish reason error: Provider finish_reason: content_filter",
    );
  });

  it("says when the runtime reports no finish reason (unpatched openclaw)", async () => {
    const m = scripted(["", ""]);
    const r = await judgeConstitution(m.fn, INPUT, { timeoutMs: 2000 });
    expect(r.emptyFinishReason).toBeUndefined();
    expect(judgeFailureCause(r)).toBe(
      "judge returned an empty reply 2 times, finish reason not reported by the runtime",
    );
  });

  it("caps a long error message at 300 characters", async () => {
    const long: LlmComplete = async () => ({ text: "", stopReason: "error", errorMessage: "x".repeat(1000) });
    const r = await judgeConstitution(long, INPUT, { timeoutMs: 2000 });
    expect(r.emptyErrorMessage).toHaveLength(300);
  });

  it("NEGATIVE CONTROL: empty then garbage is still an unparseable verdict", async () => {
    const m = scripted(["", "not json"]);
    const r = await judgeConstitution(m.fn, INPUT, { timeoutMs: 2000 });
    expect(r.emptyReplies).toBe(1);
    expect(judgeFailureCause(r)).toBe("unparseable verdict");
  });

  it("NEGATIVE CONTROL: a reply with a verdict carries no finish-reason fields", async () => {
    const m = scripted([ALLOW]);
    const r = await judgeConstitution(m.fn, INPUT, { timeoutMs: 2000 });
    expect(r.emptyFinishReason).toBeUndefined();
    expect(r.emptyErrorMessage).toBeUndefined();
  });
});
