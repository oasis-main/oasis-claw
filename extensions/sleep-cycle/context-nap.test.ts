import { describe, expect, it } from "vitest";
import {
  computeNapDecision,
  type ContextNapConfig,
  createContextNapHooks,
  promptTokensFromUsage,
} from "./src/context-nap.js";

const CFG: ContextNapConfig = {
  enabled: true,
  thresholdRatio: 0.85,
  preemptTokens: 9000, // = 5000 reserve + 4000 soft
  guardTokens: 1500,
  minAbsoluteTokens: 2000,
  minMsBetweenNaps: 60_000,
  message: "Attention exhausted. Clean-up & refresh required. Taking a quick power nap...",
  sessionMatch: ["telegram:direct"],
};

const SONNET = 200_000;
const GEMMA = 32_768;

describe("promptTokensFromUsage", () => {
  it("sums input + cache read + cache write, ignoring output", () => {
    expect(promptTokensFromUsage({ input: 100, cacheRead: 50, cacheWrite: 25, output: 999 })).toBe(
      175,
    );
  });
  it("is zero for missing usage", () => {
    expect(promptTokensFromUsage(undefined)).toBe(0);
  });
});

describe("computeNapDecision — ratio governs on a large window", () => {
  it("does not nap below 85% of sonnet", () => {
    const d = computeNapDecision({ promptTokens: 160_000, contextTokenBudget: SONNET, cfg: CFG });
    expect(d.nap).toBe(false);
    // 0.85 * 200k = 170k is below the preempt line (200k-10.5k=189.5k), so ratio wins.
    expect(d.napTokens).toBe(170_000);
    expect(d.reason).toBe("under-threshold");
  });
  it("naps at/above 85% of sonnet, tagged 'ratio'", () => {
    const d = computeNapDecision({ promptTokens: 172_000, contextTokenBudget: SONNET, cfg: CFG });
    expect(d.nap).toBe(true);
    expect(d.reason).toBe("ratio");
  });
});

describe("computeNapDecision — pre-empts native compaction on a small window", () => {
  it("fires BEFORE the compaction line on gemma", () => {
    // Native compaction (5k reserve floor): 32768 - 9000 = 23768.
    // Nap trigger: min(0.85*32768=27852, 32768-9000-1500=22268) = 22268 < 23768.
    const d = computeNapDecision({ promptTokens: 22_500, contextTokenBudget: GEMMA, cfg: CFG });
    expect(d.nap).toBe(true);
    expect(d.napTokens).toBe(22_268);
    expect(d.reason).toBe("preempt-compaction");
    expect(d.napTokens).toBeLessThan(GEMMA - CFG.preemptTokens); // beats compaction
  });
  it("does not nap when gemma still has room", () => {
    const d = computeNapDecision({ promptTokens: 20_000, contextTokenBudget: GEMMA, cfg: CFG });
    expect(d.nap).toBe(false);
  });
});

describe("computeNapDecision — guards", () => {
  it("never naps below the absolute floor", () => {
    const d = computeNapDecision({ promptTokens: 1_500, contextTokenBudget: 3_000, cfg: CFG });
    expect(d.nap).toBe(false);
    expect(d.reason).toBe("below-floor");
  });
  it("skips when the model reports no budget", () => {
    const d = computeNapDecision({ promptTokens: 500_000, contextTokenBudget: undefined, cfg: CFG });
    expect(d.nap).toBe(false);
    expect(d.reason).toBe("no-budget");
  });
});

describe("createContextNapHooks — end-to-end turn flow", () => {
  function harness(overrides?: Partial<ContextNapConfig>) {
    let now = 1_000_000;
    const napped: string[] = [];
    const hooks = createContextNapHooks({
      cfg: { ...CFG, ...overrides },
      nowMs: () => now,
      runNap: async (key) => {
        napped.push(key);
      },
    });
    return { hooks, napped, advance: (ms: number) => (now += ms) };
  }

  const KEY = "agent:main:telegram:direct:123";
  const overCtx = { sessionKey: KEY, runId: "run-1", contextTokenBudget: SONNET };
  const overEvent = { usage: { input: 180_000 } }; // 90% of 200k

  it("arms on llm_output, announces on message_sending, resets on agent_end", async () => {
    const { hooks, napped } = harness();
    hooks.onLlmOutput(overEvent, overCtx);
    const sent = hooks.onMessageSending({ content: "Here is your weather report." }, overCtx);
    expect(sent?.content).toContain("Here is your weather report.");
    expect(sent?.content).toContain("power nap");
    await hooks.onAgentEnd({}, overCtx);
    expect(napped).toEqual([KEY]);
  });

  it("announces exactly once even across chunked replies", async () => {
    const { hooks } = harness();
    hooks.onLlmOutput(overEvent, overCtx);
    const first = hooks.onMessageSending({ content: "chunk 1" }, overCtx);
    const second = hooks.onMessageSending({ content: "chunk 2" }, overCtx);
    expect(first?.content).toContain("power nap");
    expect(second).toBeUndefined();
  });

  it("does not nap a session key outside sessionMatch", async () => {
    const { hooks, napped } = harness();
    const cronCtx = { sessionKey: "cron:weather-job", runId: "run-x", contextTokenBudget: SONNET };
    hooks.onLlmOutput({ usage: { input: 190_000 } }, cronCtx);
    hooks.onMessageSending({ content: "cron output" }, cronCtx);
    await hooks.onAgentEnd({}, cronCtx);
    expect(napped).toEqual([]);
  });

  it("does not reset a turn that stayed under threshold", async () => {
    const { hooks, napped } = harness();
    hooks.onLlmOutput({ usage: { input: 100_000 } }, overCtx); // 50%
    await hooks.onAgentEnd({}, overCtx);
    expect(napped).toEqual([]);
  });

  it("debounces: a second nap within minMsBetweenNaps is suppressed", async () => {
    const { hooks, napped, advance } = harness();
    hooks.onLlmOutput(overEvent, overCtx);
    await hooks.onAgentEnd({}, overCtx);
    expect(napped).toEqual([KEY]);
    // A new turn on the same session immediately after → suppressed.
    advance(10_000);
    hooks.onLlmOutput({ usage: { input: 190_000 } }, { ...overCtx, runId: "run-2" });
    await hooks.onAgentEnd({}, { ...overCtx, runId: "run-2" });
    expect(napped).toEqual([KEY]); // still just one
    // After the debounce window, it can nap again.
    advance(60_001);
    hooks.onLlmOutput({ usage: { input: 190_000 } }, { ...overCtx, runId: "run-3" });
    await hooks.onAgentEnd({}, { ...overCtx, runId: "run-3" });
    expect(napped).toEqual([KEY, KEY]);
  });

  it("does nothing when disabled", async () => {
    const { hooks, napped } = harness({ enabled: false });
    hooks.onLlmOutput(overEvent, overCtx);
    const sent = hooks.onMessageSending({ content: "x" }, overCtx);
    await hooks.onAgentEnd({}, overCtx);
    expect(sent).toBeUndefined();
    expect(napped).toEqual([]);
  });
});
