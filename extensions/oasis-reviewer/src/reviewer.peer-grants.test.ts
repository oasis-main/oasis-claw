import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerReviewer } from "./reviewer.js";

// ── CLAW-119 phase 2: peer grants in the reviewer ────────────────────────────
// A session gets a grant by reading (reach_read) a peer message that cites it,
// when the grant checks out against the ledger. A live grant then lets the
// judge turn a covered Layer 1 ESCALATE into an allow. The negative controls
// are most of this file: a grant must never bind on a forged or mismatched
// message, never cover a NEVER_DOWNGRADE principle, never turn a deny into an
// allow, and never act without the judge's explicit allow.

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

let tmp: string;
let ledgerFile: string;
let inbox: string;
let policyPath: string;
const FUTURE = "2099-01-01T00:00:00.000Z";
const SHARED = "/reach/shared";

function grant(over: Record<string, unknown> = {}) {
  return {
    id: "GRANT-0001",
    status: "active",
    requester: "alpha",
    grantees: ["beta"],
    thread_id: "t_map",
    topic: "price map",
    intent: "beta may write notes under /reach/shared/notes",
    families: null,
    path_prefixes: null,
    max_actions: null,
    approved_at: "2026-10-13T00:00:00.000Z",
    expires: FUTURE,
    ...over,
  };
}

function writeLedger(grants: Record<string, unknown>[]) {
  fs.writeFileSync(ledgerFile, JSON.stringify({ version: 1, grants }));
  // Force a new mtime so the reader's cache refreshes inside one test.
  const t = new Date(Date.now() + Math.floor(Math.random() * 100000));
  fs.utimesSync(ledgerFile, t, t);
}

function deliver(from: string, id: string, env: Record<string, unknown>) {
  fs.writeFileSync(path.join(inbox, `${from}__${id}.json`), JSON.stringify({ id, from, to: ["beta"], ...env }));
}

function register(judge: string, bot = "beta") {
  const handlers = new Map<string, Handler>();
  const prompts: string[] = [];
  const api = {
    on: (name: string, h: Handler) => handlers.set(name, h),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    pluginConfig: {},
    runtime: {
      llm: {
        complete: async (p: { messages: { content: string }[]; systemPrompt?: string }) => {
          prompts.push(`${p.systemPrompt ?? ""}\n${p.messages.map((m) => m.content).join("\n")}`);
          return { text: judge };
        },
      },
    },
  } as unknown as Parameters<typeof registerReviewer>[0];
  const auditDir = path.join(tmp, String(Math.random()).slice(2));
  process.env.OASIS_AGENT_NAME = bot;
  registerReviewer(api, { auditDir, mode: "enforce", policyFile: policyPath });
  const call = (event: Record<string, unknown>, ctx: Record<string, unknown>) =>
    handlers.get("before_tool_call")!(event, ctx) as Promise<Record<string, any> | undefined>;
  const rows = () =>
    fs.readFileSync(path.join(auditDir, "reviewer-audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { call, rows, prompts };
}

const read = (id: string) => ({ toolName: "reach_read", toolCallId: `r_${id}`, params: { id } });
const write = (p = `${SHARED}/notes/map.md`) => ({ toolName: "write", toolCallId: "w1", params: { path: p, content: "x" } });
// Grants bind per session in module state, so every test gets fresh session ids.
let testNo = 0;
const ATTENDED = (s = "s1") => ({ sessionId: `${testNo}-${s}`, sessionKey: "agent:main:telegram:direct:1", runId: `run-${testNo}-${s}` });
const MAIL_WOKEN = (s = "s-hook") => ({ sessionId: `${testNo}-${s}`, sessionKey: "agent:main:hook:reach-1", runId: `run-${testNo}-${s}` });
const ALLOW = '{"verdict":"allow","principle":"peer-grant"}';
const ESCALATE = '{"verdict":"escalate","principle":"BEYOND","reason":"outside the grant intent"}';

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-reviewer-grants-"));
  ledgerFile = path.join(tmp, "peer-grants.json");
  inbox = path.join(tmp, "inbox");
  fs.mkdirSync(inbox);
  policyPath = path.join(tmp, "reviewer-policy.json");
  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      constitution: { fleet: ["Serve Mike's genuine intent."], per_bot: {} },
      hard: {
        fleet: {},
        per_bot: {
          beta: {
            escalateWriteRoots: [SHARED],
            consentRequiredExtra: { push: "^git push\\b" },
          },
        },
      },
    }),
  );
  process.env.OASIS_REVIEWER_L2 = "enforce";
  process.env.OASIS_REVIEWER_PEER_GRANTS_FILE = ledgerFile;
  process.env.OASIS_REVIEWER_MAIL_INBOX = inbox;
});

beforeEach(() => {
  testNo++;
  for (const f of fs.readdirSync(inbox)) fs.rmSync(path.join(inbox, f));
  writeLedger([grant()]);
  delete process.env.OASIS_REVIEWER_MAIL_WAKE_REQUIRES_GRANT;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of [
    "OASIS_REVIEWER_L2",
    "OASIS_REVIEWER_PEER_GRANTS_FILE",
    "OASIS_REVIEWER_MAIL_INBOX",
    "OASIS_REVIEWER_MAIL_WAKE_REQUIRES_GRANT",
    "OASIS_AGENT_NAME",
  ])
    delete process.env[k];
});

describe("binding a grant to a session", () => {
  it("reading a message whose grant checks out binds it, and a covered escalate becomes an allow", async () => {
    deliver("alpha", "m_1", { thread_id: "t_map", grant_id: "GRANT-0001" });
    const r = register(ALLOW);
    await r.call(read("m_1"), ATTENDED());
    expect(r.rows().at(-1)).toMatchObject({ grantBound: "GRANT-0001" });

    const out = await r.call(write(), ATTENDED());
    expect(out).toBeUndefined();
    const row = r.rows().at(-1);
    expect(row).toMatchObject({
      verdict: "allow",
      principle: "hard:escalate-write-root+peer-grant",
      coveringGrant: "GRANT-0001",
      grantDowngrade: true,
      liveGrants: ["GRANT-0001"],
    });
    expect(r.prompts.at(-1)).toContain("VERIFIED PEER GRANT (checked against Mike's peer-grant ledger");
    expect(r.prompts.at(-1)).toContain("GRANT-0001: Mike approved alpha's request that beta act on mail thread \"t_map\"");
  });

  it("NEGATIVE CONTROL: without a grant the same write still asks Mike", async () => {
    const r = register(ALLOW);
    const out = await r.call(write(), ATTENDED());
    expect(out?.requireApproval?.title).toBe("Reviewer approval required");
    expect(r.rows().at(-1).coveringGrant).toBeUndefined();
  });

  it.each([
    ["the sender is not the requester", "gamma", { thread_id: "t_map", grant_id: "GRANT-0001" }, "belongs to alpha"],
    ["the thread differs", "alpha", { thread_id: "t_other", grant_id: "GRANT-0001" }, "different thread"],
    ["the grant is unknown", "alpha", { thread_id: "t_map", grant_id: "GRANT-0099" }, "not in the ledger"],
  ])("NEGATIVE CONTROL: no binding when %s", async (_label, from, env, reason) => {
    deliver(from, "m_2", env);
    const r = register(ALLOW);
    await r.call(read("m_2"), ATTENDED());
    expect(r.rows().at(-1).grantBound).toBeUndefined();
    expect(String(r.rows().at(-1).grantBindRefused)).toContain(reason);
    const out = await r.call(write(), ATTENDED());
    expect(out?.requireApproval).toBeDefined();
  });

  it("NEGATIVE CONTROL: no binding when this bot is not a grantee", async () => {
    writeLedger([grant({ grantees: ["gamma"] })]);
    deliver("alpha", "m_3", { thread_id: "t_map", grant_id: "GRANT-0001" });
    const r = register(ALLOW);
    await r.call(read("m_3"), ATTENDED());
    expect(String(r.rows().at(-1).grantBindRefused)).toContain("beta is not a grantee");
  });

  it("NEGATIVE CONTROL: a body `from` that disagrees with the relay's filename binds nothing", async () => {
    fs.writeFileSync(
      path.join(inbox, "gamma__m_4.json"),
      JSON.stringify({ id: "m_4", from: "alpha", thread_id: "t_map", grant_id: "GRANT-0001" }),
    );
    const r = register(ALLOW);
    await r.call(read("m_4"), ATTENDED());
    expect(r.rows().at(-1).grantBound).toBeUndefined();
  });

  it("a revoke takes effect on the next call", async () => {
    deliver("alpha", "m_5", { thread_id: "t_map", grant_id: "GRANT-0001" });
    const r = register(ALLOW);
    await r.call(read("m_5"), ATTENDED());
    writeLedger([grant({ status: "revoked" })]);
    const out = await r.call(write(), ATTENDED());
    expect(out?.requireApproval).toBeDefined();
    expect(r.rows().at(-1).liveGrants).toBeUndefined();
  });

  it("a grant bound in one session does not cover another session", async () => {
    deliver("alpha", "m_6", { thread_id: "t_map", grant_id: "GRANT-0001" });
    const r = register(ALLOW);
    await r.call(read("m_6"), ATTENDED("s-a"));
    const out = await r.call(write(), ATTENDED("s-b"));
    expect(out?.requireApproval).toBeDefined();
  });
});

describe("what a grant cannot do", () => {
  it("NEGATIVE CONTROL: the judge's escalate stands even under a grant", async () => {
    deliver("alpha", "m_7", { thread_id: "t_map", grant_id: "GRANT-0001" });
    const r = register(ESCALATE);
    await r.call(read("m_7"), ATTENDED());
    const out = await r.call(write(), ATTENDED());
    expect(out?.requireApproval).toBeDefined();
    expect(r.rows().at(-1).grantDowngrade).toBeUndefined();
  });

  it("NEGATIVE CONTROL: a NEVER_DOWNGRADE principle is not covered", async () => {
    deliver("alpha", "m_8", { thread_id: "t_map", grant_id: "GRANT-0001" });
    const r = register(ALLOW);
    await r.call(read("m_8"), ATTENDED());
    const out = await r.call({ toolName: "exec", toolCallId: "e1", params: { command: "git push origin dev" } }, ATTENDED());
    expect(out?.requireApproval).toBeDefined();
    expect(r.rows().at(-1)).toMatchObject({ principle: "hard:operator-consent-required" });
    expect(r.rows().at(-1).coveringGrant).toBeUndefined();
  });

  it("path limits: a write outside path_prefixes is not covered", async () => {
    writeLedger([grant({ path_prefixes: [`${SHARED}/notes`] })]);
    deliver("alpha", "m_9", { thread_id: "t_map", grant_id: "GRANT-0001" });
    const r = register(ALLOW);
    await r.call(read("m_9"), ATTENDED());
    expect(await r.call(write(`${SHARED}/notes/a.md`), ATTENDED())).toBeUndefined();
    const out = await r.call(write(`${SHARED}/notesX/a.md`), ATTENDED());
    expect(out?.requireApproval).toBeDefined();
  });

  it("max_actions stops covering after the limit", async () => {
    writeLedger([grant({ id: "GRANT-0002", max_actions: 1 })]);
    deliver("alpha", "m_10", { thread_id: "t_map", grant_id: "GRANT-0002" });
    const r = register(ALLOW);
    await r.call(read("m_10"), ATTENDED());
    expect(await r.call(write(), ATTENDED())).toBeUndefined();
    const out = await r.call(write(), ATTENDED());
    expect(out?.requireApproval).toBeDefined();
  });
});

describe("runs that peer mail wakes up (OASIS_REVIEWER_MAIL_WAKE_REQUIRES_GRANT)", () => {
  it("switch off: CLAW-078 downgrade unchanged", async () => {
    const r = register(ALLOW);
    expect(await r.call(write(), MAIL_WOKEN())).toBeUndefined();
    expect(r.rows().at(-1).principle).toBe("hard:escalate-write-root+unattended-downgrade");
  });

  it("switch on: no grant → fails closed with a retry hint", async () => {
    process.env.OASIS_REVIEWER_MAIL_WAKE_REQUIRES_GRANT = "1";
    const r = register(ALLOW);
    const out = await r.call(write(), MAIL_WOKEN());
    expect(out?.block).toBe(true);
    expect(String(out?.blockReason)).toContain("no peer grant from Mike covers this call");
    expect(String(out?.blockReason)).toContain("reach_grant_request");
  });

  it("switch on: a covering grant allows", async () => {
    process.env.OASIS_REVIEWER_MAIL_WAKE_REQUIRES_GRANT = "1";
    deliver("alpha", "m_11", { thread_id: "t_map", grant_id: "GRANT-0001" });
    const r = register(ALLOW);
    await r.call(read("m_11"), MAIL_WOKEN("s-w"));
    expect(await r.call(write(), MAIL_WOKEN("s-w"))).toBeUndefined();
    expect(r.rows().at(-1).principle).toBe("hard:escalate-write-root+peer-grant");
  });

  it("switch on: a cron run keeps the CLAW-078 downgrade", async () => {
    process.env.OASIS_REVIEWER_MAIL_WAKE_REQUIRES_GRANT = "1";
    const r = register(ALLOW);
    const out = await r.call(write(), { sessionId: "s-cron", sessionKey: "agent:main:cron:job-1", runId: "run-cron" });
    expect(out).toBeUndefined();
    expect(r.rows().at(-1).principle).toBe("hard:escalate-write-root+unattended-downgrade");
  });
});
