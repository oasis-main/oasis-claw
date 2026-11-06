import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAuthorityViewCache, useFingerprint } from "./authority.js";
import { registerReviewer } from "./reviewer.js";

// ── Step 3 part 2: the reviewer applies the authority hub's view ─────────────
// Load-bearing: a Mike freeze blocks before any review and in shadow mode
// too; fail-closed turns every card and every downgrade into a deny; a shadow
// (automatic) restriction only adds to the audit; an expired one does
// nothing; grantMode "require" uses only grants whose mirror is current, and
// "observe" only records the mirror state.

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

let tmp: string;
let ledgerFile: string;
let viewFile: string;
let policyPath: string;
const FUTURE = "2099-01-01T00:00:00.000Z";
const SHARED = "/reach/shared";
const ALLOW = '{"verdict":"allow","principle":"directive"}';

const directive = {
  id: "DIR-0001",
  kind: "directive",
  status: "active",
  requester: "mike",
  grantees: ["beta"],
  thread_id: null,
  lane: null,
  topic: "price map notes",
  intent: "write notes under /reach/shared/notes",
  must_not: "push",
  families: null,
  path_prefixes: null,
  max_actions: null,
  approved_at: "2026-11-02T00:00:00.000Z",
  expires: FUTURE,
};

let tick = 0;
function touch(file: string) {
  const t = new Date(Date.now() + ++tick * 1000);
  fs.utimesSync(file, t, t);
}

function writeLedger(grants: Record<string, unknown>[]) {
  fs.writeFileSync(ledgerFile, JSON.stringify({ version: 1, grants }));
  touch(ledgerFile);
}

const item = (over: Record<string, unknown> = {}) => ({
  id: `r${Math.random().toString(16).slice(2)}`,
  target: "agent:beta",
  level: "chat-only",
  trigger: "mike",
  byRoot: true,
  at: "2026-11-02T19:00:00.000Z",
  expiresAt: null,
  reason: "frozen by Mike",
  mode: "enforce",
  ...over,
});

let seq = 0;
function writeView({ items = [] as unknown[], grants = {} as Record<string, unknown>, grantMode = "observe" } = {}) {
  seq++;
  fs.writeFileSync(
    viewFile,
    JSON.stringify({
      v: 1,
      kind: "authority.view",
      bot: "beta",
      at: new Date().toISOString(),
      restrictions: { seq, head: "h", items },
      ledger: { seq, head: "l", grantMode, grants },
    }),
  );
  touch(viewFile);
}

function register(mode: "enforce" | "shadow" = "enforce") {
  const handlers = new Map<string, Handler>();
  const prompts: string[] = [];
  const api = {
    on: (name: string, h: Handler) => handlers.set(name, h),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    pluginConfig: {},
    runtime: {
      llm: {
        complete: async (p: { messages: { content: string }[] }) => {
          prompts.push(p.messages.map((m) => m.content).join("\n"));
          return { text: ALLOW };
        },
      },
    },
  } as unknown as Parameters<typeof registerReviewer>[0];
  const auditDir = path.join(tmp, String(Math.random()).slice(2));
  process.env.OASIS_AGENT_NAME = "beta";
  registerReviewer(api, { auditDir, mode, policyFile: policyPath });
  const call = (event: Record<string, unknown>) =>
    handlers.get("before_tool_call")!(event, ATTENDED) as Promise<Record<string, any> | undefined>;
  const rows = () =>
    fs.readFileSync(path.join(auditDir, "reviewer-audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { call, rows, prompts };
}

const ATTENDED = { sessionId: "s1", sessionKey: "agent:main:telegram:direct:1", runId: "run-1" };
const write = () => ({ toolName: "write", toolCallId: "w1", params: { path: `${SHARED}/notes/map.md`, content: "x" } });
const read = () => ({ toolName: "read", toolCallId: "r1", params: { path: `${SHARED}/notes/map.md` } });

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-reviewer-authority-hook-"));
  ledgerFile = path.join(tmp, "peer-grants.json");
  viewFile = path.join(tmp, "authority.json");
  policyPath = path.join(tmp, "reviewer-policy.json");
  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      constitution: { fleet: ["Serve Mike's genuine intent."], per_bot: {} },
      hard: { fleet: {}, per_bot: { beta: { escalateWriteRoots: [SHARED] } } },
    }),
  );
  process.env.OASIS_REVIEWER_L2 = "enforce";
  process.env.OASIS_REVIEWER_PEER_GRANTS_FILE = ledgerFile;
  process.env.OASIS_REVIEWER_MAIL_INBOX = path.join(tmp, "inbox");
  process.env.OASIS_REVIEWER_AUTHORITY_FILE = viewFile;
});

beforeEach(() => {
  resetAuthorityViewCache();
  fs.rmSync(viewFile, { force: true });
  writeLedger([]);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of [
    "OASIS_REVIEWER_L2",
    "OASIS_REVIEWER_PEER_GRANTS_FILE",
    "OASIS_REVIEWER_MAIL_INBOX",
    "OASIS_REVIEWER_AUTHORITY_FILE",
    "OASIS_AGENT_NAME",
  ])
    delete process.env[k];
});

describe("restrictions", () => {
  it("NEGATIVE CONTROL: without a view the escalating write asks Mike, as today", async () => {
    const r = register();
    expect((await r.call(write()))?.requireApproval).toBeDefined();
    expect(r.rows().at(-1).restriction).toBeUndefined();
  });

  it("a Mike freeze (chat-only) blocks a tool call before any review or model call", async () => {
    writeView({ items: [item()] });
    const r = register();
    const out = await r.call(read());
    expect(out?.block).toBe(true);
    expect(out?.blockReason).toContain("restricted (chat-only)");
    expect(r.prompts).toHaveLength(0);
    expect(r.rows().at(-1)).toMatchObject({ verdict: "deny", principle: "authority:chat-only", enforced: true, restriction: { level: "chat-only", changed: true } });
  });

  it("a Mike freeze blocks when the reviewer itself runs in shadow mode", async () => {
    writeView({ items: [item()] });
    const r = register("shadow");
    expect((await r.call(write()))?.block).toBe(true);
  });

  it("at the chat floor the bot can still call report_injection", async () => {
    writeView({ items: [item()] });
    const r = register();
    const out = await r.call({ toolName: "report_injection", toolCallId: "i1", params: { incidentType: "x" } });
    expect(out?.block).toBeUndefined();
  });

  it("fail-closed turns the escalate into a deny: no card", async () => {
    writeView({ items: [item({ level: "fail-closed" })] });
    const r = register();
    const out = await r.call(write());
    expect(out?.requireApproval).toBeUndefined();
    expect(out?.block).toBe(true);
    expect(r.rows().at(-1)).toMatchObject({ principle: "authority:fail-closed", restriction: { level: "fail-closed", changed: true } });
  });

  it("fail-closed: a directive cannot turn the escalate into an allow", async () => {
    writeLedger([directive]);
    writeView({ items: [item({ level: "fail-closed" })] });
    const r = register();
    const out = await r.call(write());
    expect(out?.block).toBe(true);
    expect(r.rows().at(-1)).toMatchObject({ coveringGrant: "DIR-0001", principle: "authority:fail-closed" });
  });

  it("fail-closed leaves a plain allow alone", async () => {
    writeView({ items: [item({ level: "fail-closed" })] });
    const r = register();
    expect(await r.call(read())).toBeUndefined();
    expect(r.rows().at(-1)).toMatchObject({ verdict: "allow", restriction: { level: "fail-closed", changed: false } });
  });

  it("a shadow (automatic) restriction only adds restrictionShadow: Mike still gets the card", async () => {
    writeView({ items: [item({ level: "fail-closed", trigger: "count-rule", byRoot: false, mode: "shadow" })] });
    const r = register();
    expect((await r.call(write()))?.requireApproval).toBeDefined();
    expect(r.rows().at(-1)).toMatchObject({ restrictionShadow: { level: "fail-closed", wouldDeny: true } });
    expect(r.rows().at(-1).restriction).toBeUndefined();
  });

  it("an expired restriction does nothing", async () => {
    writeView({ items: [item({ expiresAt: "2020-01-01T00:00:00.000Z" })] });
    const r = register();
    expect((await r.call(read()))?.block).toBeUndefined();
  });

  it("FAIL STATIC: the view file goes away and the freeze stays", async () => {
    writeView({ items: [item()] });
    const r = register();
    expect((await r.call(read()))?.block).toBe(true);
    fs.rmSync(viewFile);
    expect((await r.call(read()))?.block).toBe(true);
    expect(String(r.rows().at(-1).authorityFault)).toContain("gone");
  });
});

describe("grants against the hub's mirror", () => {
  const mirrored = { [directive.id]: { use: useFingerprint(directive), legal: true, anomaly: null } };

  it("observe: an unmirrored directive still allows, and the row says missing", async () => {
    writeLedger([directive]);
    writeView({ grantMode: "observe" });
    const r = register();
    expect(await r.call(write())).toBeUndefined();
    expect(r.rows().at(-1)).toMatchObject({ coveringGrant: "DIR-0001", grantMirror: { "DIR-0001": "missing" } });
  });

  it("require: an unmirrored directive is not used, so Mike gets the card", async () => {
    writeLedger([directive]);
    writeView({ grantMode: "require" });
    const r = register();
    expect((await r.call(write()))?.requireApproval).toBeDefined();
    expect(r.rows().at(-1)).toMatchObject({ grantMirror: { "DIR-0001": "missing" } });
    expect(r.rows().at(-1).coveringGrant).toBeUndefined();
  });

  it("require: a mirrored, legal, current directive is used", async () => {
    writeLedger([directive]);
    writeView({ grantMode: "require", grants: mirrored });
    const r = register();
    expect(await r.call(write())).toBeUndefined();
    expect(r.rows().at(-1)).toMatchObject({ coveringGrant: "DIR-0001", grantMirror: { "DIR-0001": "ok" } });
  });

  it("require: a directive whose file record differs from the mirror (a changed must-not line) is not used", async () => {
    writeLedger([{ ...directive, must_not: "nothing" }]);
    writeView({ grantMode: "require", grants: mirrored });
    const r = register();
    expect((await r.call(write()))?.requireApproval).toBeDefined();
    expect(r.rows().at(-1)).toMatchObject({ grantMirror: { "DIR-0001": "changed" } });
  });

  it("require: a directive that the hub marked not legal is not used", async () => {
    writeLedger([directive]);
    writeView({ grantMode: "require", grants: { [directive.id]: { ...mirrored[directive.id], legal: false, anomaly: "expires changed" } } });
    const r = register();
    expect((await r.call(write()))?.requireApproval).toBeDefined();
    expect(r.rows().at(-1)).toMatchObject({ grantMirror: { "DIR-0001": "anomaly" } });
  });
});
