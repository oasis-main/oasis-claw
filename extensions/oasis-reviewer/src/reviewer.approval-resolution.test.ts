import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerReviewer } from "./reviewer.js";

// ── Approval-card outcomes (2026-10-12) ──────────────────────────────────────
// Mike's answer on a card is the ground-truth label for GEN-007 and for the
// peer-grant work, and it was recorded nowhere. Each card now carries an
// onResolution that writes one phase:"approval_resolution" row. The negative
// controls: an allow or a deny writes no such row, and adding the callback does
// not change what the hook returns.

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

let tmpDir: string;
let policyPath: string;
const ATTENDED = { sessionId: "s-tg", sessionKey: "agent:main:telegram:direct:1", runId: "r-tg" };

function register(verdictJson: string) {
  const handlers = new Map<string, Handler>();
  const api = {
    on: (name: string, h: Handler) => handlers.set(name, h),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    pluginConfig: {},
    runtime: { llm: { complete: async () => ({ text: verdictJson }) } },
  } as unknown as Parameters<typeof registerReviewer>[0];
  const auditDir = path.join(tmpDir, String(Math.random()).slice(2));
  registerReviewer(api, { auditDir, mode: "enforce", policyFile: policyPath });
  handlers.get("llm_input")!({ prompt: "clean out the old build directory" }, { runId: "r-tg", sessionId: "s-tg" });
  const call = (command: string) =>
    handlers.get("before_tool_call")!(
      { toolName: "exec", toolCallId: "toolu_card1", params: { command } },
      ATTENDED,
    ) as Promise<Record<string, any> | undefined>;
  const rows = () => {
    const f = path.join(auditDir, "reviewer-audit.jsonl");
    return fs.existsSync(f)
      ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
  };
  return { call, rows };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-reviewer-approval-resolution-"));
  policyPath = path.join(tmpDir, "reviewer-policy.json");
  fs.writeFileSync(
    policyPath,
    JSON.stringify({ constitution: { fleet: ["Serve Mike's genuine intent."], per_bot: {} }, hard: { fleet: {}, per_bot: {} } }),
  );
  process.env.OASIS_REVIEWER_L2 = "enforce";
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.OASIS_REVIEWER_L2;
});

const ESCALATE = '{"verdict":"escalate","principle":"BEYOND_REQUEST","reason":"deletes more than the build directory"}';
const ALLOW = '{"verdict":"allow","principle":"1"}';
const DENY = '{"verdict":"deny","principle":"EXFIL","reason":"sends a key out"}';
const CMD = "rm -rf build dist";

describe("approval_resolution rows", () => {
  it("a reviewer card records Mike's answer with the context the judge had", async () => {
    const r = register(ESCALATE);
    const out = await r.call(CMD);
    expect(out?.requireApproval?.title).toBe("Reviewer approval required");
    expect(r.rows().some((x) => x.phase === "approval_resolution")).toBe(false);

    await out!.requireApproval.onResolution("deny");
    const row = r.rows().at(-1);
    expect(row).toMatchObject({
      phase: "approval_resolution",
      cardKind: "reviewer",
      resolution: "deny",
      toolCallId: "toolu_card1",
      toolName: "exec",
      sessionKey: ATTENDED.sessionKey,
      unattended: false,
      l2Verdict: "escalate",
      l2Reason: "deletes more than the build directory",
      operatorRequest: "clean out the old build directory",
      cardTitle: "Reviewer approval required",
    });
    expect(row.params).toContain(CMD);
    expect(row.cardDescription).toBe(out!.requireApproval.description);
    expect(typeof row.waitMs).toBe("number");
  });

  it("NEGATIVE CONTROL: allow and deny verdicts issue no card and no resolution row", async () => {
    for (const verdict of [ALLOW, DENY]) {
      const r = register(verdict);
      const out = await r.call(CMD);
      expect(out?.requireApproval).toBeUndefined();
      expect(r.rows().some((x) => x.phase === "approval_resolution")).toBe(false);
    }
  });

  it("the card itself is unchanged apart from the callback", async () => {
    const r = register(ESCALATE);
    const out = await r.call(CMD);
    const { onResolution, ...card } = out!.requireApproval;
    expect(typeof onResolution).toBe("function");
    expect(card).toMatchObject({
      severity: "warning",
      timeoutMs: 600_000,
      timeoutBehavior: "deny",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
  });
});
