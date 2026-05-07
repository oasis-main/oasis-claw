/**
 * Auditor regression tests — exercises the multi-turn loop against a mocked
 * Anthropic API. The point is to lock in two specific behaviors:
 *
 *  1. Parallel tool_uses in a single assistant turn must all get tool_result
 *     blocks in the immediately-following user message. We learned this the
 *     hard way: when Opus emits two inspect_file calls in parallel and we
 *     only respond to the first, the API returns:
 *       "messages.N: tool_use ids were found without tool_result blocks
 *        immediately after"
 *     and the next turn fails with HTTP 400.
 *
 *  2. emit_audit is terminal even when it appears alongside other tool_uses.
 *     We don't need to send tool_results for the unrelated tool_uses because
 *     we're not sending another message after the terminal call.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAudit } from "./auditor.js";
import { Inspector, DEFAULT_AUDITABLE_EXT } from "./inspector.js";
import type { SkillSnapshot } from "./skill-scanner.js";

const validVerdictInput = {
  verdict: "pass",
  risk_score: 5,
  summary: "stub",
  findings: [],
  coverage: { audited_files: 1, declared_external_refs: [], unaudited_paths: [], pct_visible: 100 },
};

let tmpRoot: string;
let originalFetch: typeof fetch;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "auditor-test-"));
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

function mkSnapshot(): SkillSnapshot {
  return {
    skillId: "test-skill",
    rootDir: tmpRoot,
    baseDir: path.join(tmpRoot, "skill"),
    files: [{ relPath: "SKILL.md", size: 32, truncated: false, contents: "# test\n\nUses extensions/foo.\n" }],
    contentHash: "deadbeef",
    externalRefs: ["sibling:extensions/foo"],
  };
}

function mkInspector(): Inspector {
  // Two readable files inside the inspect root so the model can "inspect" them.
  const root = path.join(tmpRoot, "src");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "a.ts"), "export const A = 1;\n");
  fs.writeFileSync(path.join(root, "b.ts"), "export const B = 2;\n");
  return new Inspector({
    inspectRoots: [root],
    maxFiles: 5,
    maxTotalBytes: 10_000,
    maxBytesPerFile: 1_000,
    auditableExt: DEFAULT_AUDITABLE_EXT,
  });
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe("auditor — parallel tool_uses regression", () => {
  it("packs tool_results for ALL inspect_file calls when emitted in parallel", async () => {
    const fetchMock = vi.fn();

    // Turn 1: model returns TWO inspect_file tool_uses in one assistant turn.
    fetchMock.mockResolvedValueOnce(jsonResponse({
      content: [
        { type: "text", text: "Inspecting both entry points." },
        { type: "tool_use", id: "toolu_aaa", name: "inspect_file", input: { path: "a.ts", reason: "first" } },
        { type: "tool_use", id: "toolu_bbb", name: "inspect_file", input: { path: "b.ts", reason: "second" } },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    }));

    // Turn 2: model returns emit_audit. The auditor's payload here is what we
    // assert on — both tool_uses from turn 1 must have corresponding
    // tool_results in the immediately-prior user message of this turn's body.
    fetchMock.mockResolvedValueOnce(jsonResponse({
      content: [{ type: "tool_use", id: "toolu_emit", name: "emit_audit", input: validVerdictInput }],
      usage: { input_tokens: 200, output_tokens: 80 },
    }));

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = mkSnapshot();
    const inspector = mkInspector();
    const verdict = await runAudit(snapshot, { apiKey: "sk-stub", model: "claude-opus-4-7", inspector });

    // Both inspect_file calls should have been resolved by the inspector.
    expect(inspector.inspected.length).toBe(2);
    expect(inspector.inspected.map((r) => r.requestedPath).sort()).toEqual(["a.ts", "b.ts"]);
    expect(inspector.inspected.every((r) => r.ok)).toBe(true);

    // The second fetch must have a user message containing tool_results for
    // BOTH ids — not just the first. This is the regression we're locking.
    const secondCall = fetchMock.mock.calls[1];
    expect(secondCall).toBeDefined();
    const body = JSON.parse((secondCall![1] as { body: string }).body) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    // messages = [user(prompt), assistant(blocks), user(tool_results)]
    expect(body.messages.length).toBe(3);
    const lastUser = body.messages[2];
    expect(lastUser.role).toBe("user");
    expect(Array.isArray(lastUser.content)).toBe(true);
    const ids = (lastUser.content as Array<{ type: string; tool_use_id: string }>)
      .filter((c) => c.type === "tool_result")
      .map((c) => c.tool_use_id)
      .sort();
    expect(ids).toEqual(["toolu_aaa", "toolu_bbb"]);

    // And the audit terminated cleanly.
    expect(verdict.verdict).toBe("pass");
    expect(verdict.inspections.length).toBe(2);
  });

  it("treats emit_audit as terminal even when other tool_uses share the same turn", async () => {
    const fetchMock = vi.fn();

    // Single turn, but model emits both inspect_file AND emit_audit. emit_audit
    // wins; we don't need to ack the inspect_file because we're not sending
    // another message.
    fetchMock.mockResolvedValueOnce(jsonResponse({
      content: [
        { type: "tool_use", id: "toolu_late_inspect", name: "inspect_file", input: { path: "a.ts", reason: "stale" } },
        { type: "tool_use", id: "toolu_emit", name: "emit_audit", input: validVerdictInput },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    }));

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = mkSnapshot();
    const inspector = mkInspector();
    const verdict = await runAudit(snapshot, { apiKey: "sk-stub", model: "claude-opus-4-7", inspector });

    expect(verdict.verdict).toBe("pass");
    // Single API call — we did NOT make a follow-up request to ack the inspect.
    expect(fetchMock.mock.calls.length).toBe(1);
    // The orphaned inspect_file is NOT processed (we never ran inspector.read).
    expect(inspector.inspected.length).toBe(0);
  });
});
