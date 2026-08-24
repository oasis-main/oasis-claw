import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fallbackSessionFilePath, readSessionTranscriptSummary } from "./transcript.js";

// ── "Sound | Full Trajectory" transcript reader (2026-08-24) ─────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-reviewer-transcript-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSession(lines: unknown[]): string {
  const p = path.join(tmpDir, "session.jsonl");
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

const HEADER = { type: "session", id: "s1", timestamp: "2026-08-24T00:00:00Z" };
const MODEL_CHANGE = { type: "model_change", provider: "anthropic", modelId: "claude-sonnet-5" };

describe("readSessionTranscriptSummary — real transcript shapes", () => {
  it("renders a user message", () => {
    const p = writeSession([HEADER, { type: "message", message: { role: "user", content: "Go for it" } }]);
    const r = readSessionTranscriptSummary(p, 10_000);
    expect(r.text).toBe("USER: Go for it");
    expect(r.turnCount).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it("renders assistant text and skips thinking blocks", () => {
    const p = writeSession([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal deliberation nobody should see", thinkingSignature: "x".repeat(2000) },
            { type: "text", text: "Confirmed the order." },
          ],
        },
      },
    ]);
    const r = readSessionTranscriptSummary(p, 10_000);
    expect(r.text).toBe("ASSISTANT: Confirmed the order.");
    expect(r.text).not.toContain("internal deliberation");
    expect(r.text).not.toContain("thinkingSignature");
  });

  it("renders an assistant tool call with a truncated argument preview", () => {
    const p = writeSession([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: "exec", arguments: { command: "python3 place_iau_call.py" } }],
        },
      },
    ]);
    const r = readSessionTranscriptSummary(p, 10_000);
    expect(r.text).toContain("[called exec(");
    expect(r.text).toContain("place_iau_call.py");
  });

  it("renders a tool result, including a past reviewer verdict recorded there", () => {
    const p = writeSession([
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "exec",
          content: [{ type: "text", text: "reviewer: needs Mike's approval — no approver in an unattended run; failing closed" }],
          details: { status: "blocked" },
        },
      },
    ]);
    const r = readSessionTranscriptSummary(p, 10_000);
    expect(r.text).toBe("TOOL RESULT (exec): reviewer: needs Mike's approval — no approver in an unattended run; failing closed");
  });

  it("skips non-message entries (session header, model_change, thinking_level_change, custom)", () => {
    const p = writeSession([
      HEADER,
      MODEL_CHANGE,
      { type: "thinking_level_change", thinkingLevel: "high" },
      { type: "custom", data: "whatever" },
      { type: "message", message: { role: "user", content: "hi" } },
    ]);
    const r = readSessionTranscriptSummary(p, 10_000);
    expect(r.text).toBe("USER: hi");
    expect(r.turnCount).toBe(1);
  });

  it("renders turns in order, oldest to newest", () => {
    const p = writeSession([
      { type: "message", message: { role: "user", content: "first" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "second" }] } },
      { type: "message", message: { role: "user", content: "third" } },
    ]);
    const r = readSessionTranscriptSummary(p, 10_000);
    expect(r.text.split("\n")).toEqual(["USER: first", "ASSISTANT: second", "USER: third"]);
  });

  it("truncates from the OLDEST end when the transcript exceeds the char budget", () => {
    const lines = Array.from({ length: 50 }, (_, i) => ({
      type: "message",
      message: { role: "user", content: `turn number ${i}` },
    }));
    const p = writeSession(lines);
    const full = readSessionTranscriptSummary(p, 100_000);
    expect(full.truncated).toBe(false);

    const capped = readSessionTranscriptSummary(p, 200);
    expect(capped.truncated).toBe(true);
    expect(capped.turnCount).toBe(50); // total turns seen, even though text was capped
    expect(capped.text).not.toContain("turn number 0"); // oldest dropped
    expect(capped.text).toContain("turn number 49"); // newest kept
  });

  it("never throws on a malformed line — skips it and keeps the rest", () => {
    const p = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(
      p,
      ['{"type":"message","message":{"role":"user","content":"before"}}', "not json at all {{{", '{"type":"message","message":{"role":"user","content":"after"}}'].join(
        "\n",
      ),
    );
    const r = readSessionTranscriptSummary(p, 10_000);
    expect(r.text).toBe("USER: before\nUSER: after");
  });

  it("returns an empty summary (never throws) when the file does not exist", () => {
    const r = readSessionTranscriptSummary(path.join(tmpDir, "does-not-exist.jsonl"), 10_000);
    expect(r).toEqual({ text: "", turnCount: 0, truncated: false });
  });
});

describe("fallbackSessionFilePath", () => {
  it("matches openclaw's real on-disk convention", () => {
    const p = fallbackSessionFilePath("abc-123", "main");
    expect(p).toBe(path.join(os.homedir(), ".openclaw", "agents", "main", "sessions", "abc-123.jsonl"));
  });

  it("defaults to the main agent when agentId is empty", () => {
    const p = fallbackSessionFilePath("abc-123", "");
    expect(p).toContain(path.join("agents", "main", "sessions"));
  });
});
