import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { distillEvents, parseSessionFile, renderDistillationAsMarkdown } from "../jsonl-parser.js";
import { createDreamTool } from "../tools/dream.js";

let tmpDir: string;
let swarmDir: string;
let historyDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-dream-test-"));
  swarmDir = path.join(tmpDir, ".swarm");
  historyDir = path.join(tmpDir, "history");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// JSONL parser unit tests
// ---------------------------------------------------------------------------

function writeSessionFile(dir: string, name: string, events: object[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return filePath;
}

describe("parseSessionFile", () => {
  it("parses valid JSONL into event objects", () => {
    const filePath = writeSessionFile(historyDir, "test.jsonl", [
      { type: "session_start", ts: "2026-04-30T10:00:00Z", sessionId: "s1" },
      { type: "llm_output", ts: "2026-04-30T10:00:01Z", sessionId: "s1", content: "Hello!" },
      { type: "session_end", ts: "2026-04-30T10:00:02Z", sessionId: "s1" },
    ]);
    const events = parseSessionFile(filePath);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("session_start");
  });

  it("silently skips malformed lines", () => {
    const filePath = path.join(historyDir, "bad.jsonl");
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(filePath, '{"type":"ok"}\nNOT JSON\n{"type":"also_ok"}\n', "utf8");
    const events = parseSessionFile(filePath);
    expect(events).toHaveLength(2);
  });

  it("returns empty array for missing file", () => {
    expect(parseSessionFile("/nonexistent/path.jsonl")).toEqual([]);
  });
});

describe("distillEvents", () => {
  it("extracts session metadata", () => {
    const events = [
      { type: "session_start", ts: "2026-04-30T10:00:00Z", sessionId: "sess-42" },
      { type: "session_end", ts: "2026-04-30T10:05:00Z", sessionId: "sess-42" },
    ];
    const d = distillEvents(events);
    expect(d.sessionId).toBe("sess-42");
    expect(d.startedAt).toBe("2026-04-30T10:00:00Z");
    expect(d.endedAt).toBe("2026-04-30T10:05:00Z");
  });

  it("counts model calls and token usage", () => {
    const events = [
      { type: "llm_output", sessionId: "s1", content: "reply 1", usage: { input_tokens: 100, output_tokens: 50 } },
      { type: "llm_output", sessionId: "s1", content: "reply 2", usage: { input_tokens: 200, output_tokens: 80 } },
    ];
    const d = distillEvents(events);
    expect(d.modelCalls).toBe(2);
    expect(d.tokensUsed).toBe(430);
  });

  it("extracts assistant text excerpts (plain string content)", () => {
    const events = [
      { type: "llm_output", sessionId: "s1", content: "I will analyze this code carefully." },
    ];
    const d = distillEvents(events);
    expect(d.assistantExcerpts).toHaveLength(1);
    expect(d.assistantExcerpts[0]).toContain("analyze this code");
  });

  it("extracts assistant text from content block array", () => {
    const events = [
      {
        type: "llm_output",
        sessionId: "s1",
        content: [
          { type: "text", text: "Here is my analysis:" },
          { type: "tool_use", id: "t1", name: "bash" },
        ],
      },
    ];
    const d = distillEvents(events);
    expect(d.assistantExcerpts[0]).toContain("Here is my analysis");
  });

  it("collects tool call names", () => {
    const events = [
      { type: "tool_call", sessionId: "s1", toolName: "bash", ts: "2026-04-30T10:01:00Z" },
      { type: "tool_call", sessionId: "s1", toolName: "bash", ts: "2026-04-30T10:02:00Z" },
      { type: "tool_call", sessionId: "s1", toolName: "read", ts: "2026-04-30T10:03:00Z" },
    ];
    const d = distillEvents(events);
    expect(d.toolCalls).toHaveLength(3);
    const names = d.toolCalls.map((t) => t.name);
    expect(names.filter((n) => n === "bash")).toHaveLength(2);
  });

  it("truncates long assistant excerpts to 300 chars", () => {
    const longText = "a".repeat(500);
    const events = [{ type: "llm_output", sessionId: "s1", content: longText }];
    const d = distillEvents(events);
    expect(d.assistantExcerpts[0].length).toBeLessThanOrEqual(300);
  });
});

describe("renderDistillationAsMarkdown", () => {
  it("renders tool summary with call counts", () => {
    const d = {
      sessionId: "s1",
      startedAt: "2026-04-30T10:00:00Z",
      endedAt: "2026-04-30T10:05:00Z",
      modelCalls: 3,
      toolCalls: [
        { name: "bash", ts: null },
        { name: "bash", ts: null },
        { name: "read", ts: null },
      ],
      assistantExcerpts: ["Found 3 issues in the code."],
      tokensUsed: 1500,
    };
    const md = renderDistillationAsMarkdown(d);
    expect(md).toContain("bash");
    expect(md).toContain("×2");
    expect(md).toContain("read");
    expect(md).toContain("Found 3 issues");
  });
});

// ---------------------------------------------------------------------------
// dream tool integration tests
// ---------------------------------------------------------------------------

describe("createDreamTool", () => {
  it("appends a DREAM section to memory.md", async () => {
    // Write a fake session file
    writeSessionFile(historyDir, "2026-04-30-s1.jsonl", [
      { type: "session_start", ts: "2026-04-30T10:00:00Z", sessionId: "s1" },
      { type: "llm_output", ts: "2026-04-30T10:01:00Z", sessionId: "s1", content: "I reviewed the code.", usage: { input_tokens: 50, output_tokens: 20 } },
      { type: "tool_call", ts: "2026-04-30T10:00:30Z", sessionId: "s1", toolName: "read" },
      { type: "session_end", ts: "2026-04-30T10:02:00Z", sessionId: "s1" },
    ]);

    const tool = createDreamTool({ swarmDir, historyDir });
    const result = await tool.invoke({ topic: "code review" });

    expect(result.status).toBe("consolidated");
    expect(result.memoryWritten).toBe(true);
    expect(result.sessionsDistilled).toBe(1);
    expect(result.totalToolCalls).toBe(1);
    expect(result.totalTokens).toBe(70);

    const memoryMd = fs.readFileSync(path.join(swarmDir, "memory.md"), "utf8");
    expect(memoryMd).toContain("DREAM");
    expect(memoryMd).toContain("code review");
    expect(memoryMd).toContain("s1");
  });

  it("handles empty historyDir gracefully", async () => {
    const tool = createDreamTool({ swarmDir, historyDir: path.join(tmpDir, "nonexistent") });
    const result = await tool.invoke({});
    expect(result.status).toBe("consolidated");
    expect(result.sessionsDistilled).toBe(0);
    expect(result.memoryWritten).toBe(true);
  });

  it("writes DREAM event to trail.log", async () => {
    const tool = createDreamTool({ swarmDir, historyDir });
    await tool.invoke({});

    const trailPath = path.join(swarmDir, "trail.log");
    expect(fs.existsSync(trailPath)).toBe(true);
    const events = fs
      .readFileSync(trailPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(events.some((e) => e.kind === "DREAM")).toBe(true);
  });

  it("respects maxFiles cap", async () => {
    // Write 5 files
    for (let i = 0; i < 5; i++) {
      writeSessionFile(historyDir, `session-${i}.jsonl`, [
        { type: "session_start", ts: new Date().toISOString(), sessionId: `s${i}` },
        { type: "session_end", ts: new Date().toISOString(), sessionId: `s${i}` },
      ]);
    }

    const tool = createDreamTool({ swarmDir, historyDir });
    const result = await tool.invoke({ maxFiles: 3 });
    expect(result.sessionsDistilled).toBe(3);
  });
});
