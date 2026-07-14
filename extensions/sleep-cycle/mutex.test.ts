import { describe, expect, it } from "vitest";
import { matchTargetSessions } from "./src/deep-tool.js";
import { chunkMarkdown, cosine } from "./src/memory-rank.js";
import {
  acquireLock,
  advanceStage,
  initialState,
  isLocked,
  isLockStale,
  MAX_QUEUE,
  queueInbound,
  releaseLock,
  STALE_LOCK_MS,
  wake,
} from "./src/mutex.js";

const NOW = 1_800_000_000_000;

describe("sleep mutex state machine", () => {
  it("full cycle: awake -> dozing -> dreaming -> deep_sleep -> light_sleep -> awake", () => {
    let s = initialState();
    expect(s.state).toBe("awake");
    expect(isLocked(s)).toBe(false);

    s = acquireLock(s, NOW, "2026-07-13");
    expect(s.state).toBe("dozing");
    expect(isLocked(s)).toBe(true);
    expect(s.lastCycleDate).toBe("2026-07-13");

    s = advanceStage(s, "dreaming");
    expect(s.state).toBe("dreaming");
    expect(isLocked(s)).toBe(true);

    s = advanceStage(s, "deep_sleep");
    expect(isLocked(s)).toBe(true);

    const { state: released } = releaseLock(s);
    expect(released.state).toBe("light_sleep");
    expect(isLocked(released)).toBe(false); // lock drops BEFORE light sleep

    const awake = wake(released);
    expect(awake.state).toBe("awake");
  });

  it("queues inbound while locked and drains on release (never dropped)", () => {
    let s = acquireLock(initialState(), NOW, "2026-07-13");
    s = queueInbound(s, { content: "urgent thing", queuedAtMs: NOW + 1 });
    s = queueInbound(s, { content: "second thing", queuedAtMs: NOW + 2 });
    expect(s.queue).toHaveLength(2);

    const { state: released, drained } = releaseLock(s);
    expect(drained.map((m) => m.content)).toEqual(["urgent thing", "second thing"]);
    expect(released.queue).toHaveLength(0);
  });

  it("bounds the queue FIFO at MAX_QUEUE", () => {
    let s = acquireLock(initialState(), NOW, "2026-07-13");
    for (let i = 0; i < MAX_QUEUE + 5; i++) {
      s = queueInbound(s, { content: `m${i}`, queuedAtMs: NOW + i });
    }
    expect(s.queue).toHaveLength(MAX_QUEUE);
    expect(s.queue[0].content).toBe("m5"); // oldest dropped
  });

  it("advanceStage is a no-op when not locked", () => {
    const s = initialState();
    expect(advanceStage(s, "dreaming").state).toBe("awake");
  });

  it("acquireLock is idempotent while locked", () => {
    const s = acquireLock(initialState(), NOW, "2026-07-13");
    const again = acquireLock(advanceStage(s, "deep_sleep"), NOW + 1, "2026-07-14");
    expect(again.state).toBe("deep_sleep");
    expect(again.lastCycleDate).toBe("2026-07-13");
  });

  it("stale-lock backstop trips only after STALE_LOCK_MS", () => {
    const s = acquireLock(initialState(), NOW, "2026-07-13");
    expect(isLockStale(s, NOW + STALE_LOCK_MS - 1)).toBe(false);
    expect(isLockStale(s, NOW + STALE_LOCK_MS + 1)).toBe(true);
    expect(isLockStale(initialState(), NOW)).toBe(false);
  });
});

describe("matchTargetSessions", () => {
  const sessions = [
    { key: "agent:main:telegram:direct:8533179295", sessionId: "aaa" },
    { key: "agent:main:main", sessionId: "bbb" },
    { key: "agent:main:telegram:group:-100", sessionId: "ccc" },
  ];
  it("filters by substring", () => {
    const hit = matchTargetSessions(sessions, ["telegram:direct"]);
    expect(hit).toHaveLength(1);
    expect(hit[0].sessionId).toBe("aaa");
  });
  it("empty match list selects nothing", () => {
    expect(matchTargetSessions(sessions, [])).toHaveLength(0);
  });
});

describe("memory-rank pure parts", () => {
  it("chunks markdown by heading and index bullets", () => {
    const md = [
      "# Title",
      "intro text",
      "## Section A",
      "a body",
      "- [Some memory](file.md) — hook text",
      "## Section B",
      "b body",
    ].join("\n");
    const chunks = chunkMarkdown("MEMORY.md", md);
    const titles = chunks.map((c) => c.title);
    expect(titles).toContain("Section A");
    expect(titles.some((t) => t.startsWith("[Some memory]"))).toBe(true);
    expect(chunks.every((c) => c.text.length <= 800)).toBe(true);
  });

  it("cosine similarity behaves", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 1], [1, 1])).toBeCloseTo(1);
    expect(cosine([], [])).toBe(0);
  });
});
