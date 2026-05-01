import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSwarmSnapshot, renderSnapshotAsPromptLines } from "../swarm-reader.js";

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

  it("shares budget across multiple files in order", () => {
    write("a.md", "A".repeat(60));
    write("b.md", "B".repeat(60));
    const result = readSwarmSnapshot({
      swarmDir,
      includeFiles: ["a.md", "b.md"],
      maxBytes: 80,
    });
    // a.md gets 60 bytes (fits), b.md gets 20 bytes then truncated
    expect(result[0].truncated).toBe(false);
    expect(result[0].content).toBe("A".repeat(60));
    expect(result[1].truncated).toBe(true);
    expect(result[1].content).toContain("B".repeat(20));
  });

  it("marks later files as truncated:true with empty content when budget is 0", () => {
    write("a.md", "A".repeat(100));
    write("b.md", "B".repeat(100));
    const result = readSwarmSnapshot({
      swarmDir,
      includeFiles: ["a.md", "b.md"],
      maxBytes: 50,
    });
    expect(result[0].truncated).toBe(true);
    expect(result[1].truncated).toBe(true);
    expect(result[1].content).toBe(""); // budget exhausted before reaching b.md
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
