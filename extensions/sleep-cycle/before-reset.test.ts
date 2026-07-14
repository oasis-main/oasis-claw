import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BeforeResetDeps, handleBeforeReset, messagesToHandoff } from "./src/before-reset.js";
import type { SleepDeepConfig } from "./src/deep-tool.js";
import { StateStore } from "./src/state-store.js";

const CFG: SleepDeepConfig = {
  timezone: "UTC",
  sessionMatch: ["telegram:direct"],
  wakingSummary: { enabled: true, memoryHits: 3, transcriptPointers: 3, injectUntilHour: 24 },
  semanticsEndpoint: "http://127.0.0.1:1", // unreachable → rankMemoryHits degrades to []
  semanticsModel: "default",
};

const NOW = Date.UTC(2026, 6, 14, 4, 31);

let tmp: string;
let workspaceDir: string;

function makeDeps(): { deps: BeforeResetDeps; store: StateStore } {
  const store = new StateStore(path.join(tmp, "state"));
  return {
    store,
    deps: { cfg: CFG, workspaceDir, store, nowMs: () => NOW },
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "before-reset-test-"));
  workspaceDir = path.join(tmp, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "MEMORY.md"), "# Memory\n\n- [636 Rox](x.md) — deal notes\n");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("messagesToHandoff", () => {
  it("formats the last user/assistant turns, skipping tool/system", () => {
    const msgs = [
      { role: "system", content: "boot" },
      { role: "user", content: "how is 636 Roxborough" },
      { role: "assistant", content: [{ type: "text", text: "on track for July 20" }] },
      { role: "tool", content: "…" },
    ];
    const out = messagesToHandoff(msgs);
    expect(out).toContain("user: how is 636 Roxborough");
    expect(out).toContain("assistant: on track for July 20");
    expect(out).not.toContain("boot");
  });

  it("accepts the wrapped transcript record shape too", () => {
    const msgs = [{ type: "message", message: { role: "user", content: "hi" } }];
    expect(messagesToHandoff(msgs)).toBe("user: hi");
  });

  it("returns empty for no conversational messages", () => {
    expect(messagesToHandoff([{ role: "tool", content: "x" }])).toBe("");
    expect(messagesToHandoff([])).toBe("");
  });
});

describe("handleBeforeReset", () => {
  it("stages a waking summary for a scheduled 'daily' reset", async () => {
    const { deps, store } = makeDeps();
    const staged = await handleBeforeReset(
      { reason: "daily", sessionFile: "/x/abc.jsonl", messages: [{ role: "user", content: "confirmed conventional" }] },
      deps,
    );
    expect(staged).toBe(true);
    expect(store.state.state).toBe("light_sleep");
    expect(store.state.lastCycle?.handoff).toContain("confirmed conventional");
    expect(store.state.lastCycle?.dateKey).toBe("2026-07-14");
    expect(store.state.lastCycle?.archives[0]?.transcriptPath).toBe("/x/abc.jsonl");
  });

  it("skips non-scheduled reset reasons (manual tool / new / compaction)", async () => {
    for (const reason of ["reset", "new", "compaction", "deleted", undefined]) {
      const { deps, store } = makeDeps();
      const staged = await handleBeforeReset(
        { reason, messages: [{ role: "user", content: "hi" }] } as never,
        deps,
      );
      expect(staged).toBe(false);
      expect(store.state.lastCycle).toBeUndefined();
    }
  });

  it("skips a scheduled reset with no conversational content", async () => {
    const { deps, store } = makeDeps();
    const staged = await handleBeforeReset({ reason: "daily", messages: [] }, deps);
    expect(staged).toBe(false);
    expect(store.state.lastCycle).toBeUndefined();
  });

  it("never throws even on a malformed event", async () => {
    const { deps } = makeDeps();
    await expect(
      handleBeforeReset({ reason: "daily", messages: [null, 42, { role: "user", content: "ok" }] as never }, deps),
    ).resolves.toBe(true);
  });
});
