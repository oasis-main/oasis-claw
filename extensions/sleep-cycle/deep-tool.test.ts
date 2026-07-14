import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSleepDeepTool, runDeepSleep, type SleepDeepConfig } from "./src/deep-tool.js";
import { StateStore } from "./src/state-store.js";

const CFG: SleepDeepConfig = {
  timezone: "UTC",
  sessionMatch: ["telegram:direct"],
  wakingSummary: { enabled: true, memoryHits: 3, transcriptPointers: 3, injectUntilHour: 12 },
  semanticsEndpoint: "http://127.0.0.1:1", // unreachable → rankMemoryHits degrades to []
  semanticsModel: "default",
};

const SESSION_KEY = "agent:main:telegram:direct:123";
const SESSION_ID = "aaaa-bbbb";
const OTHER_KEY = "agent:main:main";

let tmpHome: string;
let sessDir: string;
let workspaceDir: string;
const NOW = Date.UTC(2026, 6, 13, 22, 40);

function writeTranscript() {
  const file = path.join(sessDir, `${SESSION_ID}.jsonl`);
  const rec = (role: string, text: string) =>
    JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
  fs.writeFileSync(file, [rec("user", "how is the deal going"), rec("assistant", "636 Rox is on track")].join("\n"));
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "sleep-deep-test-"));
  sessDir = path.join(tmpHome, ".openclaw", "agents", "main", "sessions");
  workspaceDir = path.join(tmpHome, ".openclaw", "workspace");
  fs.mkdirSync(sessDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "MEMORY.md"), "# Memory\n\n- [636 Rox](x.md) — deal notes\n");
  writeTranscript();
});

afterEach(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

function makeDeps(calls: Array<{ method: string; params: unknown }>) {
  const store = new StateStore(path.join(tmpHome, "state"));
  return {
    deps: {
      cfg: CFG,
      homeDir: tmpHome,
      workspaceDir,
      store,
      nowMs: () => NOW,
      call: async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === "sessions.list") {
          return {
            sessions: [
              { key: SESSION_KEY, sessionId: SESSION_ID },
              { key: OTHER_KEY, sessionId: "cccc" },
            ],
          };
        }
        return { ok: true };
      },
    },
    store,
  };
}

describe("runDeepSleep", () => {
  it("resets only matched sessions and records the waking summary", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const { deps, store } = makeDeps(calls);

    const r = await runDeepSleep(deps);

    expect(r.resetCount).toBe(1);
    expect(r.archives[0].sessionKey).toBe(SESSION_KEY);

    // Only the telegram:direct session is reset — not agent:main:main.
    const resets = calls.filter((c) => c.method === "sessions.reset");
    expect(resets).toHaveLength(1);
    expect((resets[0].params as { key: string }).key).toBe(SESSION_KEY);

    // State file has the handoff tail + lastCycle for the waking supplement.
    expect(store.state.state).toBe("light_sleep");
    expect(store.state.lastCycle?.handoff).toContain("636 Rox");
    expect(store.state.lastCycle?.dateKey).toBe("2026-07-13");
  });

  it("survives sessions.list failure without throwing", async () => {
    const { deps } = makeDeps([]);
    deps.call = async (m: string) => {
      if (m === "sessions.list") throw new Error("gateway down");
      return { ok: true };
    };
    const r = await runDeepSleep(deps);
    expect(r.resetCount).toBe(0);
  });

  it("tool wrapper returns a text summary and never throws", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const { deps } = makeDeps(calls);
    const tool = createSleepDeepTool(deps);
    expect(tool.name).toBe("sleep_deep");
    const out = await tool.execute("call-1", {});
    expect(out.content[0].text).toContain("sleep_deep complete");
    expect(out.content[0].text).toContain("reset 1 session");
  });
});
