import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSwarmCompactionProvider, digestMessages, readLatestHandoff } from "../compaction-provider.js";
import { createCompactTool } from "../tools/compact.js";

let tmpDir: string;
let swarmDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-compact-test-"));
  swarmDir = path.join(tmpDir, ".swarm");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// compact tool tests
// ---------------------------------------------------------------------------

describe("createCompactTool", () => {
  it("appends a HANDOFF section to state.md", async () => {
    const tool = createCompactTool({ swarmDir });
    const note = "We were working on the oasis-claw plugin scaffold. All six extensions are built. Next: run Stage 4 testing and push to oasis-main.";
    const result = await tool.invoke({ handoffNote: note, sessionTag: "test-compact-1" });

    expect(result.status).toBe("snapshot_written");
    expect(result.snapshotWritten).toBe(true);
    expect(fs.existsSync(result.snapshotPath)).toBe(true);

    const stateMd = fs.readFileSync(result.snapshotPath, "utf8");
    expect(stateMd).toContain("Handoff Note");
    expect(stateMd).toContain("test-compact-1");
    expect(stateMd).toContain("oasis-claw plugin scaffold");
  });

  it("uses ISO timestamp as default sessionTag", async () => {
    const tool = createCompactTool({ swarmDir });
    const result = await tool.invoke({
      handoffNote: "Generic handoff note for testing purposes. Contains enough text to pass validation.",
    });
    expect(result.sessionTag).toMatch(/^compact-\d{4}-\d{2}-\d{2}T/);
  });

  it("writes COMPACT event to trail.log", async () => {
    const tool = createCompactTool({ swarmDir });
    await tool.invoke({
      handoffNote: "Testing compact trail event. This note is long enough at over fifty characters.",
    });

    const trailPath = path.join(swarmDir, "trail.log");
    expect(fs.existsSync(trailPath)).toBe(true);
    const events = fs
      .readFileSync(trailPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const compactEvent = events.find((e) => e.kind === "COMPACT");
    expect(compactEvent).toBeDefined();
    expect(compactEvent.snapshotWritten).toBe(true);
  });

  it("accumulates multiple handoffs in state.md", async () => {
    const tool = createCompactTool({ swarmDir });
    await tool.invoke({ handoffNote: "First handoff: started the project. Working on initial scaffolding.", sessionTag: "v1" });
    await tool.invoke({ handoffNote: "Second handoff: plugins are done. Tests are passing. Ready to push.", sessionTag: "v2" });

    const stateMd = fs.readFileSync(path.join(swarmDir, "state.md"), "utf8");
    expect(stateMd).toContain("v1");
    expect(stateMd).toContain("v2");
    expect(stateMd).toContain("First handoff");
    expect(stateMd).toContain("Second handoff");
  });

  it("creates swarmDir if it does not exist", async () => {
    const deepSwarm = path.join(tmpDir, "a", "b", "c", ".swarm");
    const tool = createCompactTool({ swarmDir: deepSwarm });
    const result = await tool.invoke({
      handoffNote: "Deep path test. Verifying that nested directories are created automatically.",
    });
    expect(result.snapshotWritten).toBe(true);
    expect(fs.existsSync(deepSwarm)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SwarmCompactionProvider tests
// ---------------------------------------------------------------------------

describe("readLatestHandoff", () => {
  it("returns null when state.md does not exist", () => {
    expect(readLatestHandoff(path.join(swarmDir, "state.md"))).toBeNull();
  });

  it("returns null when state.md has no HANDOFF sections", () => {
    fs.mkdirSync(swarmDir, { recursive: true });
    fs.writeFileSync(path.join(swarmDir, "state.md"), "# State\n\nSome notes here.\n", "utf8");
    expect(readLatestHandoff(path.join(swarmDir, "state.md"))).toBeNull();
  });

  it("extracts the body of a HANDOFF section", async () => {
    const tool = createCompactTool({ swarmDir });
    const note = "Working on ORG-050. Sleep and dream tools are done. Compact needs the compaction provider wired.";
    await tool.invoke({ handoffNote: note, sessionTag: "test-read" });

    const handoff = readLatestHandoff(path.join(swarmDir, "state.md"));
    expect(handoff).not.toBeNull();
    expect(handoff).toContain("ORG-050");
    expect(handoff).toContain("compaction provider");
  });

  it("returns the LAST handoff when multiple exist", async () => {
    const tool = createCompactTool({ swarmDir });
    await tool.invoke({ handoffNote: "First session: built the scaffolding. All extensions created.", sessionTag: "s1" });
    await tool.invoke({ handoffNote: "Second session: wrote all the tests. Everything is passing now.", sessionTag: "s2" });

    const handoff = readLatestHandoff(path.join(swarmDir, "state.md"));
    expect(handoff).toContain("Second session");
    expect(handoff).not.toContain("First session");
  });
});

describe("SwarmCompactionProvider", () => {
  it("has correct id and label", () => {
    const provider = createSwarmCompactionProvider({ swarmDir });
    expect(provider.id).toBe("swarm-compact");
    expect(provider.label).toContain("Swarm");
  });

  it("returns handoff note when one exists in state.md", async () => {
    // Write a handoff via compact tool
    const tool = createCompactTool({ swarmDir });
    const note = "Agent compacted at 80% context. Next steps: finish ORG-050 tests, push to main, update queue.";
    await tool.invoke({ handoffNote: note, sessionTag: "pre-compact" });

    const provider = createSwarmCompactionProvider({ swarmDir });
    const summary = await provider.summarize({ messages: [] });

    expect(summary).toContain("Compaction Summary");
    expect(summary).toContain("ORG-050 tests");
    expect(summary).toContain("state.md");
  });

  it("falls back to message digest when no handoff exists", async () => {
    const provider = createSwarmCompactionProvider({ swarmDir });
    const messages = [
      { role: "user", content: "Help me refactor this TypeScript class." },
      { role: "assistant", content: "Sure, let me look at the code. I'll start by analyzing the structure." },
      { role: "user", content: "Also can you add tests?" },
      { role: "assistant", content: "Absolutely. I'll add vitest unit tests for each method." },
    ];

    const summary = await provider.summarize({ messages });
    expect(summary).toContain("Session Digest");
    expect(summary).toContain("refactor");
    expect(summary).toContain("vitest");
    expect(summary).toContain("no agent handoff note found");
  });

  it("handles previousSummary in params without error", async () => {
    const provider = createSwarmCompactionProvider({ swarmDir });
    const result = await provider.summarize({
      messages: [{ role: "user", content: "Hello" }],
      previousSummary: "Prior compaction summary text.",
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("digestMessages", () => {
  it("extracts user and assistant text", () => {
    const messages = [
      { role: "user", content: "What is 2 + 2?" },
      { role: "assistant", content: "4" },
    ];
    const result = digestMessages(messages);
    expect(result).toContain("User");
    expect(result).toContain("Agent");
    expect(result).toContain("2 + 2");
    expect(result).toContain("4");
  });

  it("skips system messages", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
    ];
    const result = digestMessages(messages);
    expect(result).not.toContain("You are a helpful assistant");
    expect(result).toContain("Hello");
  });

  it("handles content block arrays", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "I found the issue in line 42." },
          { type: "tool_use", id: "t1", name: "bash" },
        ],
      },
    ];
    const result = digestMessages(messages);
    expect(result).toContain("line 42");
  });

  it("truncates to maxChars", () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({
      role: "user",
      content: `Message ${i}: ${"x".repeat(200)}`,
    }));
    const result = digestMessages(messages, 500);
    expect(result.length).toBeLessThanOrEqual(520); // small buffer for truncation marker
  });
});
