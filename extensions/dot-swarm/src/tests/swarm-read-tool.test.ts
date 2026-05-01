import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSwarmReadTool } from "../tools/swarm-read.js";

let tmpDir: string;
let swarmDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-swarmtool-test-"));
  swarmDir = path.join(tmpDir, ".swarm");
  fs.mkdirSync(swarmDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(filename: string, content: string): void {
  fs.writeFileSync(path.join(swarmDir, filename), content, "utf8");
}

describe("createSwarmReadTool", () => {
  it("has correct name and non-empty description", () => {
    const tool = createSwarmReadTool({
      swarmDir,
      includeFiles: ["state.md"],
      maxBytes: 65_536,
    });
    expect(tool.name).toBe("swarm_read");
    expect(tool.description.length).toBeGreaterThan(20);
  });

  it("returns swarmDir in result", async () => {
    const tool = createSwarmReadTool({ swarmDir, includeFiles: ["state.md"], maxBytes: 65_536 });
    const result = await tool.invoke({});
    expect(result.swarmDir).toBe(swarmDir);
  });

  it("returns file metadata for missing files", async () => {
    const tool = createSwarmReadTool({
      swarmDir,
      includeFiles: ["state.md", "queue.md"],
      maxBytes: 65_536,
    });
    const result = await tool.invoke({});
    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toMatchObject({ filename: "state.md", exists: false });
    expect(result.files[1]).toMatchObject({ filename: "queue.md", exists: false });
  });

  it("returns rendered prompt text for existing files", async () => {
    write("state.md", "# Current\n\nDoing great work.");
    const tool = createSwarmReadTool({
      swarmDir,
      includeFiles: ["state.md"],
      maxBytes: 65_536,
    });
    const result = await tool.invoke({});
    expect(result.rendered).toContain("state.md");
    expect(result.rendered).toContain("Doing great work.");
  });

  it("respects args.files override", async () => {
    write("memory.md", "Extra memory file.");
    const tool = createSwarmReadTool({
      swarmDir,
      includeFiles: ["state.md", "queue.md"],
      maxBytes: 65_536,
    });
    // Override to read only memory.md
    const result = await tool.invoke({ files: ["memory.md"] });
    expect(result.files).toHaveLength(1);
    expect(result.files[0].filename).toBe("memory.md");
    expect(result.files[0].exists).toBe(true);
    expect(result.rendered).toContain("Extra memory file.");
  });

  it("reports truncated:true in file metadata when budget is tight", async () => {
    write("state.md", "X".repeat(500));
    const tool = createSwarmReadTool({
      swarmDir,
      includeFiles: ["state.md"],
      maxBytes: 100,
    });
    const result = await tool.invoke({});
    expect(result.files[0].truncated).toBe(true);
    expect(result.rendered).toContain("(truncated)");
  });

  it("rendered is a non-empty string even with no swarm files", async () => {
    const tool = createSwarmReadTool({
      swarmDir,
      includeFiles: ["state.md"],
      maxBytes: 65_536,
    });
    const result = await tool.invoke({});
    expect(typeof result.rendered).toBe("string");
    expect(result.rendered.length).toBeGreaterThan(0);
  });

  it("uses default includeFiles when args.files is not provided", async () => {
    write("state.md", "default included");
    write("queue.md", "also included");
    const tool = createSwarmReadTool({
      swarmDir,
      includeFiles: ["state.md", "queue.md"],
      maxBytes: 65_536,
    });
    const result = await tool.invoke({});
    expect(result.files.map((f) => f.filename)).toEqual(["state.md", "queue.md"]);
  });
});
