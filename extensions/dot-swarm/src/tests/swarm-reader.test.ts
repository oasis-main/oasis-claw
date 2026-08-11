import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readSwarmSnapshot,
  renderSnapshotAsPromptLines,
  renderStatusPromptLines,
  statSwarmFiles,
} from "../swarm-reader.js";

let tmpDir: string;
let swarmDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-dotswarm-test-"));
  swarmDir = path.join(tmpDir, ".swarm");
  fs.mkdirSync(swarmDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function write(filename: string, content: string): void {
  fs.writeFileSync(path.join(swarmDir, filename), content, "utf8");
}

// ---------------------------------------------------------------------------
// readSwarmSnapshot — core behavior
// ---------------------------------------------------------------------------

describe("readSwarmSnapshot — file presence", () => {
  it("returns exists:false for missing files without throwing", () => {
    const result = readSwarmSnapshot({
      swarmDir,
      includeFiles: ["state.md", "queue.md"],
      maxBytes: 65_536,
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ filename: "state.md", exists: false, bytes: 0, content: "" });
    expect(result[1]).toMatchObject({ filename: "queue.md", exists: false, bytes: 0, content: "" });
  });

  it("reads an existing file with full content", () => {
    write("state.md", "# State\n\nAll good.");
    const [snap] = readSwarmSnapshot({
      swarmDir,
      includeFiles: ["state.md"],
      maxBytes: 65_536,
    });
    expect(snap.exists).toBe(true);
    expect(snap.content).toBe("# State\n\nAll good.");
    expect(snap.truncated).toBe(false);
    expect(snap.bytes).toBe("# State\n\nAll good.".length);
  });

  it("handles a mix of present and absent files", () => {
    write("state.md", "present");
    const result = readSwarmSnapshot({
      swarmDir,
      includeFiles: ["state.md", "queue.md", "memory.md"],
      maxBytes: 65_536,
    });
    expect(result[0].exists).toBe(true);
    expect(result[1].exists).toBe(false);
    expect(result[2].exists).toBe(false);
  });

  it("preserves includeFiles order in output", () => {
    write("a.md", "AAA");
    write("b.md", "BBB");
    write("c.md", "CCC");
    const result = readSwarmSnapshot({
      swarmDir,
      includeFiles: ["c.md", "a.md", "b.md"],
      maxBytes: 65_536,
    });
    expect(result.map((r) => r.filename)).toEqual(["c.md", "a.md", "b.md"]);
  });

  it("returns empty array for empty includeFiles", () => {
    const result = readSwarmSnapshot({ swarmDir, includeFiles: [], maxBytes: 65_536 });
    expect(result).toHaveLength(0);
  });
});

describe("readSwarmSnapshot — byte budget", () => {
  it("does not truncate when content fits within budget", () => {
    write("state.md", "hello");
    const [snap] = readSwarmSnapshot({
      swarmDir,
      includeFiles: ["state.md"],
      maxBytes: 100,
    });
    expect(snap.truncated).toBe(false);
    expect(snap.content).toBe("hello");
  });

  it("truncates a single file that exceeds maxBytes", () => {
    write("state.md", "A".repeat(200));
    const [snap] = readSwarmSnapshot({
      swarmDir,
      includeFiles: ["state.md"],
      maxBytes: 50,
    });
    expect(snap.exists).toBe(true);
    expect(snap.truncated).toBe(true);
    expect(snap.bytes).toBe(200);
    expect(snap.content).toContain("A".repeat(50));
    expect(snap.content).toContain("[truncated");
  });

  // CLAW-082: the budget is split fairly, NOT consumed in includeFiles order.
  // The old sequential reader starved the last file to empty content on every
  // real board, which an agent reads as "that file is empty".
  it("splits the budget so an oversized first file cannot starve the second", () => {
    write("a.md", "A".repeat(100));
    write("b.md", "B".repeat(100));
    const result = readSwarmSnapshot({
      swarmDir,
      includeFiles: ["a.md", "b.md"],
      maxBytes: 50,
    });
    expect(result[0].truncated).toBe(true);
    expect(result[1].truncated).toBe(true);
    // Both get 25 bytes, not 50/0.
    expect(result[0].content).toContain("A".repeat(25));
    expect(result[1].content).toContain("B".repeat(25));
    expect(result[1].content).not.toBe("");
  });

  it("returns the surplus of a small file to the files that need it", () => {
    write("a.md", "A".repeat(10));
    write("b.md", "B".repeat(500));
    const result = readSwarmSnapshot({
      swarmDir,
      includeFiles: ["a.md", "b.md"],
      maxBytes: 100,
    });
    // a.md needs only 10 of its 50-byte share; b.md gets the remaining 90.
    expect(result[0].truncated).toBe(false);
    expect(result[0].content).toBe("A".repeat(10));
    expect(result[1].truncated).toBe(true);
    expect(result[1].content).toContain("B".repeat(90));
  });

  it("reports the TRUE on-disk size of a truncated file, not the shown size", () => {
    write("state.md", "S".repeat(5000));
    const [snap] = readSwarmSnapshot({
      swarmDir,
      includeFiles: ["state.md"],
      maxBytes: 100,
    });
    expect(snap.truncated).toBe(true);
    expect(snap.bytes).toBe(5000);
  });

  it("budget of 0 marks all existing files as truncated", () => {
    write("state.md", "anything");
    const [snap] = readSwarmSnapshot({
      swarmDir,
      includeFiles: ["state.md"],
      maxBytes: 0,
    });
    expect(snap.truncated).toBe(true);
    expect(snap.content).toBe("");
  });

  it("missing files do not consume budget", () => {
    write("b.md", "B".repeat(10));
    const result = readSwarmSnapshot({
      swarmDir,
      includeFiles: ["missing.md", "b.md"],
      maxBytes: 20,
    });
    expect(result[0].exists).toBe(false);
    expect(result[1].exists).toBe(true);
    expect(result[1].truncated).toBe(false);
    expect(result[1].content).toBe("B".repeat(10));
  });
});

describe("readSwarmSnapshot — edge cases", () => {
  it("handles empty files without error", () => {
    write("empty.md", "");
    const [snap] = readSwarmSnapshot({
      swarmDir,
      includeFiles: ["empty.md"],
      maxBytes: 1000,
    });
    expect(snap.exists).toBe(true);
    expect(snap.content).toBe("");
    expect(snap.bytes).toBe(0);
    expect(snap.truncated).toBe(false);
  });

  it("handles unicode content correctly (byte vs char budget)", () => {
    // emoji is 4 bytes in UTF-8; budget should be generous enough to pass
    const content = "🔥".repeat(5);
    write("state.md", content);
    const [snap] = readSwarmSnapshot({
      swarmDir,
      includeFiles: ["state.md"],
      maxBytes: 1000,
    });
    expect(snap.content).toBe(content);
    expect(snap.truncated).toBe(false);
  });

  it("does not throw if swarmDir does not exist (missing files reported)", () => {
    const result = readSwarmSnapshot({
      swarmDir: path.join(tmpDir, "nonexistent"),
      includeFiles: ["state.md"],
      maxBytes: 1000,
    });
    expect(result[0].exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderSnapshotAsPromptLines
// ---------------------------------------------------------------------------

describe("renderSnapshotAsPromptLines", () => {
  it("includes the swarmDir in the section header", () => {
    const snap = [{ filename: "state.md", exists: false, bytes: 0, truncated: false, content: "" }];
    const lines = renderSnapshotAsPromptLines("/my/.swarm", snap);
    expect(lines[0]).toContain("/my/.swarm");
    expect(lines[0]).toContain("Stigmergic");
  });

  it("renders file content under its heading", () => {
    const snap = [
      { filename: "state.md", exists: true, bytes: 10, truncated: false, content: "# State\n\nDone." },
    ];
    const lines = renderSnapshotAsPromptLines(swarmDir, snap);
    const joined = lines.join("\n");
    expect(joined).toContain("#### state.md");
    expect(joined).toContain("# State");
    expect(joined).toContain("Done.");
  });

  it("marks truncated files in heading", () => {
    const snap = [
      { filename: "queue.md", exists: true, bytes: 5000, truncated: true, content: "partial..." },
    ];
    const lines = renderSnapshotAsPromptLines(swarmDir, snap);
    expect(lines.join("\n")).toContain("queue.md (truncated)");
  });

  // CLAW-082: a heading with nothing under it reads as "this file is empty".
  it("never renders a truncated file as a bare heading with no body", () => {
    const snap = [
      { filename: "queue.md", exists: true, bytes: 195_069, truncated: true, content: "" },
    ];
    const joined = renderSnapshotAsPromptLines(swarmDir, snap).join("\n");
    expect(joined).toContain("195069 bytes on disk");
    expect(joined).toContain("did not fit the prompt budget");
    expect(joined).toContain('swarm_read with filename="queue.md"');
  });

  it("points a partially-shown file at swarm_read for the rest", () => {
    const snap = [
      { filename: "state.md", exists: true, bytes: 57_111, truncated: true, content: "head..." },
    ];
    const joined = renderSnapshotAsPromptLines(swarmDir, snap).join("\n");
    expect(joined).toContain("head...");
    expect(joined).toContain("57111 bytes on disk");
    expect(joined).toContain("only the head is shown");
  });

  it("skips missing files (does not add heading for them)", () => {
    const snap = [
      { filename: "missing.md", exists: false, bytes: 0, truncated: false, content: "" },
      { filename: "state.md", exists: true, bytes: 5, truncated: false, content: "hi" },
    ];
    const joined = renderSnapshotAsPromptLines(swarmDir, snap).join("\n");
    expect(joined).not.toContain("#### missing.md");
    expect(joined).toContain("#### state.md");
  });

  it("shows 'no .swarm/ files present' when all files are missing", () => {
    const snap = [
      { filename: "state.md", exists: false, bytes: 0, truncated: false, content: "" },
      { filename: "queue.md", exists: false, bytes: 0, truncated: false, content: "" },
    ];
    const joined = renderSnapshotAsPromptLines(swarmDir, snap).join("\n");
    expect(joined).toContain("no .swarm/ files present");
  });

  it("returns a string array (each line is a separate element)", () => {
    const snap = [
      { filename: "state.md", exists: true, bytes: 3, truncated: false, content: "abc" },
    ];
    const lines = renderSnapshotAsPromptLines(swarmDir, snap);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.every((l) => typeof l === "string")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// statSwarmFiles — memory-prompt supplement's stat-only path (CLAW-083)
// ---------------------------------------------------------------------------

describe("statSwarmFiles", () => {
  it("returns exists:false for missing files without throwing", () => {
    const result = statSwarmFiles({ swarmDir, includeFiles: ["state.md", "queue.md"] });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ filename: "state.md", exists: false, bytes: 0, mtimeMs: 0 });
  });

  it("reports the true on-disk size without reading content", () => {
    write("queue.md", "Q".repeat(195_069));
    const [stat] = statSwarmFiles({ swarmDir, includeFiles: ["queue.md"] });
    expect(stat.exists).toBe(true);
    expect(stat.bytes).toBe(195_069);
  });

  it("does not throw if swarmDir does not exist", () => {
    const result = statSwarmFiles({
      swarmDir: path.join(tmpDir, "nonexistent"),
      includeFiles: ["state.md"],
    });
    expect(result[0].exists).toBe(false);
  });

  it("reports a positive mtimeMs for an existing file", () => {
    write("state.md", "hi");
    const [stat] = statSwarmFiles({ swarmDir, includeFiles: ["state.md"] });
    expect(stat.mtimeMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// renderStatusPromptLines — the actual per-turn supplement payload (CLAW-083)
// ---------------------------------------------------------------------------

describe("renderStatusPromptLines", () => {
  const nowMs = 1_800_000_000_000;

  it("includes the swarmDir in the section header", () => {
    const lines = renderStatusPromptLines("/my/.swarm", [{ filename: "state.md", exists: false, bytes: 0, mtimeMs: 0 }], nowMs);
    expect(lines[0]).toContain("/my/.swarm");
    expect(lines[0]).toContain("Stigmergic");
  });

  it("reports size and staleness per file, never the content", () => {
    const stats = [
      { filename: "state.md", exists: true, bytes: 57_111, mtimeMs: nowMs - 5 * 60_000 },
      { filename: "queue.md", exists: true, bytes: 195_069, mtimeMs: nowMs - 3 * 60 * 60_000 },
    ];
    const joined = renderStatusPromptLines(swarmDir, stats, nowMs).join("\n");
    expect(joined).toContain("state.md: 57,111 bytes, updated 5m ago");
    expect(joined).toContain("queue.md: 195,069 bytes, updated 3h ago");
    expect(joined).toContain("swarm_read");
    expect(joined).toContain("memory_search");
  });

  it("never contains file content, only a pointer", () => {
    const stats = [{ filename: "state.md", exists: true, bytes: 5, mtimeMs: nowMs }];
    const joined = renderStatusPromptLines(swarmDir, stats, nowMs).join("\n");
    expect(joined).not.toContain("SECRET_MARKER_WOULD_APPEAR_IF_CONTENT_LEAKED");
    expect(joined).toContain("pointer, not a copy");
  });

  it("skips missing files", () => {
    const stats = [
      { filename: "missing.md", exists: false, bytes: 0, mtimeMs: 0 },
      { filename: "state.md", exists: true, bytes: 5, mtimeMs: nowMs },
    ];
    const joined = renderStatusPromptLines(swarmDir, stats, nowMs).join("\n");
    expect(joined).not.toContain("missing.md");
    expect(joined).toContain("state.md");
  });

  it("shows 'no .swarm/ files present' when all files are missing", () => {
    const stats = [{ filename: "state.md", exists: false, bytes: 0, mtimeMs: 0 }];
    const joined = renderStatusPromptLines(swarmDir, stats, nowMs).join("\n");
    expect(joined).toContain("no .swarm/ files present");
  });

  it("formats sub-minute staleness as 'just now'", () => {
    const stats = [{ filename: "state.md", exists: true, bytes: 5, mtimeMs: nowMs - 10_000 }];
    const joined = renderStatusPromptLines(swarmDir, stats, nowMs).join("\n");
    expect(joined).toContain("just now");
  });

  it("formats multi-day staleness in days", () => {
    const stats = [{ filename: "state.md", exists: true, bytes: 5, mtimeMs: nowMs - 3 * 24 * 60 * 60_000 }];
    const joined = renderStatusPromptLines(swarmDir, stats, nowMs).join("\n");
    expect(joined).toContain("3d ago");
  });
});

// ---------------------------------------------------------------------------
// Integration: real .swarm/ files round-trip
// ---------------------------------------------------------------------------

describe("readSwarmSnapshot + renderSnapshotAsPromptLines — round-trip", () => {
  it("produces non-empty prompt lines for existing swarm state", () => {
    write(
      "state.md",
      [
        "# Oasis-X State — 2026-05-01",
        "",
        "## Current work",
        "Building dot-swarm plugin tests.",
        "",
        "## Next",
        "ORG-030 tests → push → mark done.",
      ].join("\n"),
    );
    write(
      "queue.md",
      "# Queue\n\n- [ ] [ORG-030] [OPEN] dot-swarm plugin tests\n",
    );

    const snapshot = readSwarmSnapshot({
      swarmDir,
      includeFiles: ["state.md", "queue.md"],
      maxBytes: 65_536,
    });
    const lines = renderSnapshotAsPromptLines(swarmDir, snapshot);
    const rendered = lines.join("\n");

    expect(rendered).toContain("state.md");
    expect(rendered).toContain("queue.md");
    expect(rendered).toContain("Building dot-swarm plugin tests");
    expect(rendered).toContain("ORG-030");
  });

  it("byte budget is faithfully reflected in rendered output", () => {
    // state.md = 400 bytes (fits in 1000 budget), queue.md = 3000 bytes (only 600 left → truncated)
    write("state.md", "S".repeat(400));
    write("queue.md", "Q".repeat(3000));

    const snapshot = readSwarmSnapshot({
      swarmDir,
      includeFiles: ["state.md", "queue.md"],
      maxBytes: 1000,
    });
    const rendered = renderSnapshotAsPromptLines(swarmDir, snapshot).join("\n");

    expect(snapshot[0].truncated).toBe(false);
    expect(snapshot[1].truncated).toBe(true);
    expect(rendered).toContain("queue.md (truncated)");
  });
});
