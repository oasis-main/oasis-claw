// Tests for step 3 part 2 of the authority hub (scripts/claw-authority.mjs,
// 2026-11-02): the ledger mirror, the count rule and the per-bot views.
//
// Load-bearing properties:
//   1. The mirror records each change of peer-grants.json once, and marks a
//      change that breaks the ledger rules as an anomaly that stays.
//   2. The count rule restricts one instance to fail-closed for 24 h after 5
//      enforced denials in 10 minutes, once. A reviewer health failure, a
//      restriction's own deny and a shadow deny never count.
//   3. Each bot's view holds only what names that bot. A hub restriction is
//      shadow until autoMode is enforce; a root restriction is enforce.
//   4. A log that does not verify writes no view (fail static).
//   5. The grant fingerprint is the same as the reviewer's (the two values
//      are pinned in extensions/oasis-reviewer/src/authority.test.ts too).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  VIEW_FILE,
  appendEvent,
  applyCountRule,
  canonical,
  countableDenials,
  initAuthority,
  keySigner,
  loadAuthority,
  loadHubSigner,
  main,
  syncLedger,
  syncOnce,
  useFingerprint,
  verifySignature,
} from "../claw-authority.mjs";

const T0 = Date.parse("2026-11-02T20:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (t) => new Date(t).toISOString();

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "authority-sync-"));
const p256 = () => keySigner(crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);

async function setup() {
  const dir = tmp();
  const root = p256();
  let clock = T0;
  const now = () => clock;
  await initAuthority(dir, root, { now });
  const hub = loadHubSigner(dir);
  const ledgerFile = path.join(dir, "peer-grants.json");
  const viewDir = path.join(dir, "views");
  return {
    dir,
    root,
    hub,
    now,
    ledgerFile,
    viewDir,
    at: (t) => (clock = t),
    ledger: (grants) => fs.writeFileSync(ledgerFile, JSON.stringify({ version: 1, grants })),
    sync: () => syncLedger(dir, ledgerFile, hub, { now }),
    load: () => loadAuthority(dir),
  };
}

const grant = (over = {}) => ({
  id: "GRANT-0001",
  status: "proposed",
  requester: "alpha",
  grantees: ["beta"],
  thread_id: "t_map",
  topic: "price map",
  intent: "beta may write notes",
  families: null,
  path_prefixes: null,
  max_actions: null,
  proposed_at: iso(T0 - 10 * MIN),
  proposal_expires: iso(T0 + 50 * MIN),
  approved_at: null,
  expires: null,
  decided_by: null,
  card: { chat: 1, message: 2 },
  ...over,
});
const approved = (over = {}) =>
  grant({ status: "active", approved_at: iso(T0 - 5 * MIN), expires: iso(T0 - 5 * MIN + 4 * HOUR), decided_by: 8533, ...over });
const directive = (over = {}) => ({
  id: "DIR-0001",
  kind: "directive",
  status: "active",
  requester: "mike",
  grantees: ["beta"],
  thread_id: null,
  lane: "CLAW-1",
  topic: "goal",
  intent: "may",
  must_not: "push",
  families: null,
  path_prefixes: null,
  max_actions: null,
  proposed_at: iso(T0 - 2 * HOUR),
  approved_at: iso(T0 - HOUR),
  expires: iso(T0 - HOUR + 168 * HOUR),
  decided_by: 8533,
  reminded: false,
  ...over,
});
const state = (s, id) => s.load().ledger.get(id);

test("the grant fingerprint is the reviewer's (pinned on both sides)", () => {
  const g = {
    id: "GRANT-0001", status: "active", requester: "alpha", grantees: ["beta"], thread_id: "t_map", topic: "price map",
    intent: "beta may write notes", families: ["file"], path_prefixes: null, max_actions: 3,
    approved_at: "2026-11-02T20:00:00.000Z", expires: "2026-11-03T20:00:00.000Z", card: { chat: 1 }, reminded: false,
  };
  const d = {
    id: "DIR-0007", kind: "directive", status: "active", requester: "mike", grantees: ["house"], thread_id: null, lane: "CLAW-1",
    topic: "goal ü", intent: "may", must_not: "push", families: null, path_prefixes: ["/reach/x"], max_actions: null,
    approved_at: "2026-11-02T20:00:00.000Z", expires: "2026-11-09T20:00:00.000Z", requested_ttl_hours: 0.5,
  };
  assert.equal(useFingerprint(g), "00fa89320dae3e71b99b4effbbdcce0de2f209de56abeee3920abc49fbe4f57c");
  assert.equal(useFingerprint(d), "77b5cf49904da6941696fea22c5cf45ff7ee88633a7f29f5f33d0be73f25b5e8");
});

test("the mirror records each change once; a card or reminder change is not a change", async () => {
  const s = await setup();
  assert.deepEqual((await s.sync()).missing, true);
  s.ledger([grant(), directive()]);
  assert.equal((await s.sync()).appended.length, 2);
  assert.equal((await s.sync()).appended.length, 0);
  s.ledger([grant({ card: { chat: 9 } }), directive({ reminded: true })]);
  assert.equal((await s.sync()).appended.length, 0);
  s.ledger([approved(), directive()]);
  const r = await s.sync();
  assert.deepEqual(r.appended.map((e) => [e.kind, e.body.id, e.body.anomaly]), [["grant.state", "GRANT-0001", null]]);
  const auth = s.load();
  assert.equal(auth.ok, true);
  assert.equal(auth.streams.ledger.events.length, 3);
  assert.equal(state(s, "GRANT-0001").legal, true);
  assert.equal(state(s, "GRANT-0001").record.status, "active");
  assert.equal(state(s, "GRANT-0001").record.card, undefined, "cards stay out of the mirror");
});

test("ANOMALY: a terminal record that comes back, and the mark stays", async () => {
  const s = await setup();
  s.ledger([approved({ status: "denied" })]);
  await s.sync();
  s.ledger([approved()]);
  const r = await s.sync();
  assert.match(r.appended[0].body.anomaly, /a denied record became active/);
  s.ledger([approved({ status: "revoked" })]);
  await s.sync();
  assert.equal(state(s, "GRANT-0001").legal, false, "a later clean change does not clear the mark");
});

test("ANOMALY: a longer end time without a renewal, and a peer grant over 24 hours", async () => {
  const s = await setup();
  s.ledger([approved()]);
  await s.sync();
  s.ledger([approved({ expires: iso(T0 + 30 * HOUR) })]);
  const r = await s.sync();
  assert.match(r.appended[0].body.anomaly, /end time changed without a renewal/);
  assert.match(r.appended[0].body.anomaly, /longer than 24 hours/);
});

test("ANOMALY: a fixed field changes, a bot grants itself, a time in the future", async () => {
  const s = await setup();
  s.ledger([approved(), approved({ id: "GRANT-0002", grantees: ["alpha"] }), approved({ id: "GRANT-0003", approved_at: iso(T0 + HOUR), expires: iso(T0 + 2 * HOUR) })]);
  const first = await s.sync();
  assert.deepEqual(
    first.appended.map((e) => e.body.anomaly),
    [null, "a bot grants itself", "an approval or renewal time is in the future"],
  );
  s.ledger([approved({ grantees: ["beta", "gamma"] })]);
  const r = await s.sync();
  assert.match(r.appended[0].body.anomaly, /grantees changed/);
});

test("a directive renewal and a directive grace period are legal", async () => {
  const s = await setup();
  s.ledger([directive()]);
  await s.sync();
  s.at(T0 + 100 * HOUR);
  s.ledger([directive({ renewed_at: iso(T0 + 100 * HOUR), expires: iso(T0 + 268 * HOUR) })]);
  assert.equal((await s.sync()).appended[0].body.anomaly, null);
  s.at(T0 + 269 * HOUR);
  const grace = iso(T0 + 273 * HOUR);
  s.ledger([directive({ renewed_at: iso(T0 + 100 * HOUR), expires: grace, grace_until: grace })]);
  assert.equal((await s.sync()).appended[0].body.anomaly, null);
  assert.equal(state(s, "DIR-0001").legal, true);
});

test("a directive that older ledger code renewed (no renewed_at) is legal; one that ends more than 7 days from now is not", async () => {
  const s = await setup();
  // Live shape on 2026-11-02: approved 13 days ago, renewed by older code, ends in 3 days.
  s.ledger([
    directive({ approved_at: iso(T0 - 13 * 24 * HOUR), expires: iso(T0 + 3 * 24 * HOUR) }),
    directive({ id: "DIR-0002", approved_at: iso(T0 - HOUR), expires: iso(T0 + 8 * 24 * HOUR) }),
  ]);
  const r = await s.sync();
  assert.deepEqual(r.appended.map((e) => e.body.anomaly), [null, "a directive ends more than 7 days from now"]);
});

test("ANOMALY: a record removed from the file", async () => {
  const s = await setup();
  s.ledger([approved(), directive()]);
  await s.sync();
  s.ledger([directive()]);
  const r = await s.sync();
  assert.deepEqual(r.appended.map((e) => [e.kind, e.body.anomaly]), [["grant.removed", "removed from the ledger file"]]);
  assert.equal(state(s, "GRANT-0001").removed, true);
});

test("a changed ledger line breaks the chain, and nothing more is appended", async () => {
  const s = await setup();
  s.ledger([approved(), directive()]);
  await s.sync();
  const file = path.join(s.dir, "streams", "ledger.jsonl");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"beta may write notes"', '"beta may push"'));
  assert.equal(s.load().ok, false);
  s.ledger([approved({ status: "revoked" })]);
  await assert.rejects(s.sync(), /does not verify/);
});

test("a ledger event with a wrong hash or a foreign signer is refused", async () => {
  const s = await setup();
  const record = { id: "GRANT-0009", status: "active" };
  await assert.rejects(
    appendEvent(s.dir, "ledger", { kind: "grant.state", scope: "GRANT-0009", body: { id: "GRANT-0009", record, hash: "0".repeat(64), anomaly: null } }, s.hub),
    /record hash/,
  );
  const hash = crypto.createHash("sha256").update(canonical(record)).digest("hex");
  const stranger = keySigner(crypto.generateKeyPairSync("ed25519").privateKey);
  await assert.rejects(
    appendEvent(s.dir, "ledger", { kind: "grant.state", scope: "GRANT-0009", body: { id: "GRANT-0009", record, hash, anomaly: null } }, stranger),
    /not a root or a valid hub/,
  );
});

// ── the count rule ──

const deny = (i, over = {}) => ({
  ts: iso(T0 - i * MIN),
  phase: "before_tool_call",
  verdict: "deny",
  enforced: true,
  principle: "hard:deny-write-root",
  l2FailClosed: false,
  error: false,
  restriction: false,
  h: crypto.createHash("sha256").update(`row ${i} ${JSON.stringify(over)}`).digest("hex"),
  ...over,
});

test("countableDenials: health failures, restriction denies and shadow denies never count", () => {
  const rows = [
    deny(1),
    deny(2, { principle: "l2:unavailable-fail-closed" }),
    deny(3, { l2FailClosed: true }),
    deny(4, { principle: "authority:fail-closed" }),
    deny(5, { restriction: true }),
    deny(6, { enforced: false }),
    deny(7, { error: true }),
    deny(8, { phase: "approval_resolution" }),
    deny(9, { h: "short" }),
  ];
  assert.deepEqual(countableDenials(rows, "beta", "oasis-claw-beta").map((d) => d.id), [rows[0].h]);
});

test("the count rule: 5 enforced denials in 10 minutes restrict the instance once, fail-closed, 24 h", async () => {
  const s = await setup();
  const rows = [0, 1, 2, 3, 4].map((i) => deny(i));
  const denials = countableDenials(rows, "beta", "oasis-claw-beta");
  const added = await applyCountRule(s.dir, s.hub, denials, { now: s.now });
  assert.equal(added.length, 1);
  assert.deepEqual(
    { ...added[0].body, reason: undefined },
    { target: "instance:beta@oasis-claw-beta", level: "fail-closed", trigger: "count-rule", reason: undefined, evidence: rows[0].h, expiresAt: iso(T0 + 24 * HOUR) },
  );
  assert.equal((await applyCountRule(s.dir, s.hub, denials, { now: s.now })).length, 0, "no second restriction while one is in force");
  assert.equal((await applyCountRule(s.dir, s.hub, denials.slice(1), { now: s.now })).length, 0, "4 denials are not enough");
  assert.equal(s.load().ok, true);
});

// ── views ──

const fleet = [
  { key: "beta", container: "oasis-claw-beta", running: true },
  { key: "gamma", container: "oasis-claw-gamma", running: true },
];
const readView = (s, bot) => JSON.parse(fs.readFileSync(path.join(s.viewDir, bot, VIEW_FILE), "utf8"));
const rootAdd = (s, target, level = "chat-only") =>
  appendEvent(s.dir, "restrictions", { kind: "restriction.add", scope: target, body: { target, level, trigger: "mike", reason: "frozen by Mike" } }, s.root, { now: s.now });

test("syncOnce: each bot's view holds only what names it; hub items are shadow until autoMode enforce", async () => {
  const s = await setup();
  s.ledger([approved(), directive({ grantees: ["gamma"] })]);
  await rootAdd(s, "agent:gamma");
  await rootAdd(s, "fleet", "fail-closed");
  const audit = { "oasis-claw-beta": [0, 1, 2, 3, 4].map((i) => deny(i)), "oasis-claw-gamma": [] };
  const r = await syncOnce(s.dir, { ledgerFile: s.ledgerFile, viewDir: s.viewDir, fleet, collect: async (c) => audit[c], now: s.now });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.restricted, ["instance:beta@oasis-claw-beta"]);
  assert.deepEqual(r.views, ["beta", "gamma"]);

  const beta = readView(s, "beta");
  assert.deepEqual(beta.restrictions.items.map((i) => [i.target, i.level, i.mode]).sort(), [
    ["fleet", "fail-closed", "enforce"],
    ["instance:beta@oasis-claw-beta", "fail-closed", "shadow"],
  ]);
  assert.deepEqual(Object.keys(beta.ledger.grants), ["GRANT-0001"]);
  assert.equal(beta.ledger.grants["GRANT-0001"].use, useFingerprint(approved()));
  assert.equal(beta.ledger.grantMode, "observe");
  const gamma = readView(s, "gamma");
  assert.deepEqual(gamma.restrictions.items.map((i) => i.target).sort(), ["agent:gamma", "fleet"]);
  assert.deepEqual(Object.keys(gamma.ledger.grants), ["DIR-0001"]);

  // The hub signs the view over its canonical form without the signature.
  const { sig, ...unsigned } = beta;
  assert.equal(unsigned.hub, s.hub.key);
  assert.equal(verifySignature(s.hub, Buffer.from(canonical(unsigned), "utf8"), sig), true);

  await syncOnce(s.dir, { ledgerFile: s.ledgerFile, viewDir: s.viewDir, fleet, collect: async (c) => audit[c], now: s.now, autoMode: "enforce", grantMode: "require" });
  const again = readView(s, "beta");
  assert.ok(again.restrictions.items.every((i) => i.mode === "enforce"));
  assert.equal(again.ledger.grantMode, "require");
});

test("FAIL STATIC: a log that does not verify writes no view, and the last view stays", async () => {
  const s = await setup();
  s.ledger([approved()]);
  await rootAdd(s, "agent:beta");
  const opts = { ledgerFile: s.ledgerFile, viewDir: s.viewDir, fleet, collect: async () => [], now: s.now };
  await syncOnce(s.dir, opts);
  const before = fs.readFileSync(path.join(s.viewDir, "beta", VIEW_FILE), "utf8");
  const file = path.join(s.dir, "streams", "restrictions.jsonl");
  fs.writeFileSync(file, ""); // an attacker empties the restrictions stream
  s.at(T0 + MIN);
  const r = await syncOnce(s.dir, opts);
  assert.ok(r.errors.some((e) => /views not written/.test(e)), r.errors.join("; "));
  assert.equal(fs.readFileSync(path.join(s.viewDir, "beta", VIEW_FILE), "utf8"), before);
});

test("restrict refuses a bot that has no view (a typo would restrict nothing), unless --force", async () => {
  const s = await setup();
  await syncOnce(s.dir, { ledgerFile: s.ledgerFile, viewDir: s.viewDir, fleet, collect: async () => [], now: s.now });
  await assert.rejects(
    main(["freeze", "agent:betta", "--dir", s.dir, "--views", s.viewDir]),
    /no bot "betta" has a view/,
  );
  // The known bot gets past the check to the root signer (no enclave tool here).
  await assert.rejects(main(["freeze", "agent:beta", "--dir", s.dir, "--views", s.viewDir, "--tool", path.join(s.dir, "no-tool")]), /ENOENT|no-tool/);
});
