// Tests for the observatory Authority view (2026-11-03). Run with:
//   node --test scripts/tests/claw-observatory*.test.mjs
// The root is a software P-256 key here, as in claw-authority.test.mjs: the
// same signature as the Secure Enclave key, without Touch ID.
//
// Load-bearing properties:
//   1. The level of each instance is the strongest restriction that names
//      it (fleet, agent or instance). Mike's restrictions enforce; a hub's is
//      shadow until the daemon runs with auto=enforce.
//   2. The hub's cards: keep or let expire (until Mike keeps it), a storm, a
//      ledger record that is not legal, a log fault, a bot whose view is
//      missing, behind, unsigned or not mounted read-only, a red reviewer.
//   3. An action is checked before Touch ID: a bot that is not in the fleet,
//      a bad level, no reason, a lift of a restriction that is not in force,
//      a keep of one with no end or one kept already. A request signs ONE
//      event, one at a time; a key that is not a root cannot sign it.
//   4. Only counts and times leave a bot's reviewer audit.
//   5. The routes: GET reads; a POST needs the token and this page's Origin.
//   6. The daemon sends a new restriction to the bots without waiting for
//      its interval.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  VIEW_FILE,
  appendEvent,
  initAuthority,
  keySigner,
  loadAuthority,
  loadHubSigner,
  publishViews,
  runDaemon,
  syncLedger,
} from "../claw-authority.mjs";
import { checkRequest, createObservatoryServer } from "../claw-observatory.mjs";
import { classifyMount } from "../claw-observatory-access.mjs";
import {
  collectReviewerHealth,
  describeAuthority,
  healthStatus,
  planAction,
  readDaemonModes,
  readViewFile,
  runAction,
  viewMount,
  viewState,
} from "../claw-observatory-authority.mjs";

const T0 = Date.parse("2026-11-03T20:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const EVIDENCE = "e".repeat(64);
const iso = (t) => new Date(t).toISOString();
const tmp = (prefix = "observatory-authority-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const p256 = () => keySigner(crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);

const BOTS = [
  { key: "house", container: "oasis-claw-house", running: true, state: "running" },
  { key: "nimbus", container: "oasis-claw-runtime", running: true, state: "running" },
  { key: "down", container: "oasis-claw-down", running: false, state: "exited" },
];

async function setup() {
  const dir = tmp();
  const root = p256();
  let clock = T0;
  const now = () => clock;
  await initAuthority(dir, root, { now });
  const hub = loadHubSigner(dir);
  const add = (signer, body) => appendEvent(dir, "restrictions", { kind: "restriction.add", scope: body.target, body }, signer, { now });
  return { dir, root, hub, now, at: (t) => (clock = t), add, load: () => loadAuthority(dir), viewDir: path.join(dir, "views") };
}

const mikeBody = (target, level = "chat-only", extra = {}) => ({ target, level, trigger: "mike", reason: "test", ...extra });
const countBody = (target, expiresAt) => ({ target, level: "fail-closed", trigger: "count-rule", reason: "5 enforced denials in 10 minutes (count rule)", evidence: EVIDENCE, expiresAt });

const inspectWith = (key, { rw = false, source } = {}) => ({
  Config: { Env: ["OASIS_REVIEWER_MODE=enforce", "OASIS_REVIEWER_L2=enforce", "OASIS_REVIEWER_DECIDER=shadow", "OASIS_GATEWAY_TOKEN=SECRET-TOKEN-VALUE"] },
  Mounts: [{ Type: "bind", Source: source ?? `/host_mnt/Users/mike/Library/Application Support/oasis-x/authority-view/${key}`, Destination: "/reach/authority", RW: rw }],
});

async function viewsFor(s, bots = BOTS) {
  await publishViews(s.dir, s.viewDir, bots, s.hub, { now: s.now });
  return Object.fromEntries(bots.map((b) => [b.key, readViewFile(s.viewDir, b.key)]));
}

const healthy = () => ({
  rows: 10,
  calls: 8,
  verdicts: { allow: 8 },
  l2: { judged: 4, failed: 0, failedHour: 0, causes: {}, lastFailure: null },
  decider: { rows: 2, errors: 0 },
  restriction: { enforced: 0, shadowWouldDeny: 0 },
  view: { at: iso(T0), fault: null, stale: false },
  lastAt: iso(T0),
});

// ── 1. levels ────────────────────────────────────────────────────────────────

test("the level of an instance is the strongest that names it; Mike enforces, a hub is shadow until auto=enforce", async () => {
  const s = await setup();
  await s.add(s.root, mikeBody("agent:house", "read-only"));
  await s.add(s.hub, countBody("instance:house@oasis-claw-house", iso(T0 + 24 * HOUR)));
  await s.add(s.hub, countBody("instance:nimbus@oasis-claw-runtime", iso(T0 + 24 * HOUR)));
  await s.add(s.root, mikeBody("agent:other", "stopped"));
  const views = await viewsFor(s);
  const shadow = describeAuthority({ auth: s.load(), bots: BOTS, views, nowMs: T0 });
  const byKey = Object.fromEntries(shadow.instances.map((i) => [i.key, i]));
  assert.deepEqual(byKey.house.level, { enforced: "read-only", shadow: null }, "read-only beats a shadow fail-closed");
  assert.deepEqual(byKey.nimbus.level, { enforced: null, shadow: "fail-closed" });
  assert.equal(byKey.house.restrictions.length, 2);
  assert.ok(!shadow.instances.some((i) => i.restrictions.length && i.key === "down"), "a restriction for another bot is not shown");
  const enforce = describeAuthority({ auth: s.load(), bots: BOTS, views, modes: { auto: "enforce", grants: "observe" }, nowMs: T0 });
  assert.deepEqual(enforce.instances.find((i) => i.key === "nimbus").level, { enforced: "fail-closed", shadow: null });

  await s.add(s.root, mikeBody("fleet", "chat-only"));
  const frozen = describeAuthority({ auth: s.load(), bots: BOTS, views: await viewsFor(s), nowMs: T0 });
  assert.ok(frozen.instances.every((i) => i.level.enforced === "chat-only"), "a fleet freeze names every bot");
});

test("the matrix takes only the reviewer names from docker inspect, never a token", async () => {
  const s = await setup();
  const inspects = { house: inspectWith("house") };
  const d = describeAuthority({ auth: s.load(), bots: BOTS, views: await viewsFor(s), inspects, health: { house: healthy() }, nowMs: T0 });
  const house = d.instances.find((i) => i.key === "house");
  assert.deepEqual([house.reviewer.mode, house.reviewer.l2, house.reviewer.decider], ["enforce", "enforce", "shadow"]);
  assert.equal(house.reviewer.status, "ok");
  assert.equal(house.view.mount.state, "ro");
  assert.equal(house.homeHubs.length, 1);
  assert.equal(house.homeHubs[0].signsViews, true);
  assert.ok(!JSON.stringify(d).includes("SECRET-TOKEN-VALUE"));
});

// ── 2. cards ─────────────────────────────────────────────────────────────────

test("CARDS: keep or let expire shows until Mike keeps it; a storm; a ledger record that is not legal", async () => {
  const s = await setup();
  const r = await s.add(s.hub, countBody("instance:house@oasis-claw-house", iso(T0 + HOUR)));
  let d = describeAuthority({ auth: s.load(), bots: BOTS, views: await viewsFor(s), nowMs: T0 });
  const card = d.cards.find((c) => c.kind === "expiring");
  assert.equal(card?.id, r.id, "a restriction that ends within 2 h gets a keep card");
  const plan = planAction("keep", { id: r.id }, { auth: s.load(), botKeys: ["house"], nowMs: T0 });
  assert.equal(plan.entry.body.evidence, r.id);
  assert.equal(plan.entry.body.trigger, "mike");
  assert.equal(plan.entry.body.expiresAt, undefined, "a kept restriction has no end");
  const kept = await appendEvent(s.dir, "restrictions", plan.entry, s.root, { now: s.now });
  d = describeAuthority({ auth: s.load(), bots: BOTS, views: await viewsFor(s), nowMs: T0 });
  assert.ok(!d.cards.some((c) => c.kind === "expiring"), "a kept restriction has no card");
  assert.equal(d.restrictions.active.find((x) => x.id === r.id).keptBy, kept.id);
  assert.equal(planAction("keep", { id: r.id }, { auth: s.load(), botKeys: ["house"], nowMs: T0 }).status, 409, "no second keep");

  // Storm: the hub restricted house, then a1; a2 and a3 are over the budget (2 agents in 1 hour).
  for (const bot of ["a1", "a2", "a3"]) await s.add(s.hub, countBody(`agent:${bot}`, iso(T0 + 24 * HOUR)));
  d = describeAuthority({ auth: s.load(), bots: BOTS, views: await viewsFor(s), nowMs: T0 });
  const storm = d.cards.find((c) => c.kind === "storm");
  assert.ok(storm && /2 automatic restriction\(s\) held/.test(storm.title), storm?.title);
  assert.deepEqual(d.restrictions.held.map((x) => x.target), ["agent:a2", "agent:a3"]);

  // A ledger record that is not legal.
  fs.writeFileSync(path.join(s.dir, "pg.json"), JSON.stringify({ grants: [{ id: "GRANT-0001", status: "active", requester: "house", grantees: ["house"], proposed_at: iso(T0 - MIN), approved_at: iso(T0), expires: iso(T0 + HOUR) }] }));
  await syncLedger(s.dir, path.join(s.dir, "pg.json"), s.hub, { now: s.now });
  d = describeAuthority({ auth: s.load(), bots: BOTS, views: await viewsFor(s), nowMs: T0 });
  assert.ok(d.cards.some((c) => c.kind === "anomaly" && c.grant === "GRANT-0001"));
  assert.deepEqual(d.instances.find((i) => i.key === "house").grants.notLegal, ["GRANT-0001"]);
});

test("CARDS: a view that is missing, behind, stale, unsigned or not mounted read-only; a red reviewer; a log fault", async () => {
  const s = await setup();
  const views = await viewsFor(s);
  await s.add(s.root, mikeBody("agent:house"));
  const inspects = { house: inspectWith("house"), nimbus: inspectWith("nimbus", { rw: true }) };
  const red = { ...healthy(), l2: { judged: 4, failed: 2, failedHour: 1, causes: { timeout: 2 }, lastFailure: { at: iso(T0), cause: "timeout" } } };
  const sending = describeAuthority({ auth: s.load(), bots: BOTS, views: { house: views.house }, inspects, nowMs: T0 + 30_000 });
  assert.equal(sending.instances.find((i) => i.key === "house").view.state, "sending", "a view behind by a 30 s old event is on its way");
  assert.ok(!sending.cards.some((c) => c.title.startsWith("house: view")), "no card while the daemon sends");
  let d = describeAuthority({ auth: s.load(), bots: BOTS, views: { house: views.house }, inspects, health: { house: red }, nowMs: T0 + 2 * MIN });
  const titles = d.cards.map((c) => c.title);
  assert.ok(titles.includes("house: view behind"), "the view is older than the restriction, by more than 90 s");
  assert.ok(titles.includes("nimbus: the reviewer cannot read its own view"), "a read-write mount");
  assert.ok(titles.includes("house: reviewer health"));
  assert.ok(!titles.some((t) => t.startsWith("down:")), "a stopped bot gets no view card");

  const fresh = await viewsFor(s);
  d = describeAuthority({ auth: s.load(), bots: BOTS, views: fresh, inspects: { house: inspectWith("house"), nimbus: inspectWith("nimbus") }, nowMs: T0 + 11 * MIN });
  assert.equal(d.instances.find((i) => i.key === "house").view.state, "stale", "a view older than 10 min: the daemon is not running");

  const forged = { view: { ...fresh.house.view, restrictions: { ...fresh.house.view.restrictions, items: [] } } };
  assert.equal(viewState(BOTS[0], forged, s.load(), T0).state, "bad", "a changed view no longer matches its signature");
  assert.equal(viewState(BOTS[0], { view: fresh.nimbus.view }, s.load(), T0).state, "bad", "another bot's view");

  fs.appendFileSync(path.join(s.dir, "streams", "restrictions.jsonl"), "{not json}\n");
  d = describeAuthority({ auth: s.load(), bots: BOTS, views: fresh, nowMs: T0 });
  assert.equal(d.ok, false);
  assert.ok(d.cards.some((c) => c.kind === "log" && c.tone === "bad"));
});

test("viewMount: ro, rw, another folder, missing", () => {
  assert.equal(viewMount(inspectWith("house"), "house").state, "ro");
  assert.equal(viewMount(inspectWith("house", { rw: true }), "house").state, "rw");
  assert.equal(viewMount(inspectWith("house", { source: "/Users/mike/Library/Application Support/oasis-x/authority-view/nimbus" }), "house").state, "other-folder");
  assert.equal(viewMount({ Mounts: [] }, "house").state, "missing");
});

// ── 3. actions ───────────────────────────────────────────────────────────────

test("planAction checks each request before Touch ID", async () => {
  const s = await setup();
  const opts = { auth: s.load(), botKeys: ["house", "nimbus"], nowMs: T0 };
  const err = (op, body) => planAction(op, body, opts).error;
  assert.match(err("restrict", { target: "agent:hosue", level: "chat-only", reason: "x" }), /no bot "hosue"/, "a typo restricts nothing");
  assert.match(err("restrict", { target: "everyone", level: "chat-only", reason: "x" }), /the target is/);
  assert.match(err("restrict", { target: "agent:house", level: "off", reason: "x" }), /the level is one of/);
  assert.match(err("restrict", { target: "agent:house", level: "chat-only", reason: "  " }), /give a reason/);
  assert.match(err("restrict", { target: "agent:house", level: "chat-only", reason: "x", hours: 0 }), /hours is a whole number/);
  assert.match(err("restrict", { target: "agent:house", level: "chat-only", reason: "x", hours: 1.5 }), /hours is a whole number/);
  assert.match(err("lift", { ids: ["f".repeat(64)] }), /not in force/);
  assert.match(err("lift", { ids: [] }), /ids is a list/);
  assert.match(err("explode", {}), /unknown action/);
  const plan = planAction("restrict", { target: "instance:house@oasis-claw-house", level: "stopped", reason: " stop it ", hours: 4 }, opts);
  assert.deepEqual(plan.entry.body, { target: "instance:house@oasis-claw-house", level: "stopped", trigger: "mike", reason: "stop it", expiresAt: iso(T0 + 4 * HOUR) });
  assert.equal(planAction("restrict", { target: "fleet", level: "chat-only", reason: "x" }, opts).entry.scope, "fleet");
  const r = await s.add(s.root, mikeBody("agent:house", "chat-only"));
  assert.match(planAction("keep", { id: r.id }, { ...opts, auth: s.load() }).error, /has no end/);
});

test("runAction signs ONE root event; a second request while Touch ID waits gets 409; a hub key cannot sign it", async () => {
  const s = await setup();
  let release;
  const gate = new Promise((r) => (release = r));
  const slowRoot = { ...s.root, sign: async (bytes) => (await gate, s.root.sign(bytes)) };
  const first = runAction("restrict", { target: "agent:house", level: "chat-only", reason: "frozen" }, { dir: s.dir, botKeys: ["house"], signer: async () => slowRoot, now: s.now });
  const second = await runAction("restrict", { target: "agent:house", level: "chat-only", reason: "again" }, { dir: s.dir, botKeys: ["house"], signer: async () => s.root, now: s.now });
  assert.equal(second.status, 409, "one Touch ID prompt at a time");
  release();
  const r = await first;
  assert.equal(r.ok, true);
  assert.equal(r.event.kind, "restriction.add");
  const events = s.load().streams.restrictions.events;
  assert.equal(events.length, 1);
  assert.equal(events[0].signer.key, s.root.key);

  const lift = await runAction("lift", { ids: [r.event.id] }, { dir: s.dir, botKeys: ["house"], signer: async () => s.root, now: s.now });
  assert.equal(lift.ok, true);
  assert.equal(s.load().streams.restrictions.events.length, 2);

  const byHub = await runAction("restrict", { target: "agent:house", level: "chat-only", reason: "x" }, { dir: s.dir, botKeys: ["house"], signer: async () => s.hub, now: s.now });
  assert.ok(byHub.error && /refused/.test(byHub.error), "the log refuses a hub's 'mike' restriction");
  assert.equal(s.load().streams.restrictions.events.length, 2, "nothing was appended");

  const noTouch = await runAction("restrict", { target: "agent:house", level: "chat-only", reason: "x" }, {
    dir: s.dir,
    botKeys: ["house"],
    signer: async () => ({ ...s.root, sign: async () => { throw new Error("oasis-root-key stopped after 180 s with no answer (no Touch ID?)"); } }),
    now: s.now,
  });
  assert.match(noTouch.error, /no Touch ID/);
  assert.equal(s.load().streams.restrictions.events.length, 2);
});

// ── 4. the reviewer audit ────────────────────────────────────────────────────

test("collectReviewerHealth: judge failures by cause, the view state, and only counts leave the bot", () => {
  const home = tmp("authority-health-");
  fs.mkdirSync(path.join(home, "logs", "reviewer"), { recursive: true });
  const now = T0;
  const row = (over) => JSON.stringify({ ts: iso(now - 5 * MIN), phase: "before_tool_call", verdict: "allow", params: "{\"cmd\":\"cat SECRET-PARAM\"}", reason: "SECRET-REASON", ...over });
  const lines = [
    row({ l2Judged: true, l2Verdict: "allow" }),
    row({ l2Judged: true, l2Verdict: null, l2TimedOut: true }),
    row({ l2Judged: true, l2Verdict: null, l2EmptyReplies: 1, ts: iso(now - 3 * HOUR) }),
    row({ l2Judged: false }),
    row({ verdict: "deny", restriction: { level: "chat-only", changed: true } }),
    row({ restrictionShadow: { level: "fail-closed", wouldDeny: true } }),
    JSON.stringify({ ts: iso(now - MIN), phase: "decider_shadow", decError: "boom" }),
    row({ ts: iso(now - 2 * 86_400_000), l2Judged: true, l2Verdict: null }),
    row({ ts: iso(now - MIN), authorityFault: "the view file is gone; the last good view stays in force" }),
    "not json",
  ];
  fs.writeFileSync(path.join(home, "logs", "reviewer", "reviewer-audit.jsonl"), `${lines.join("\n")}\n`);
  const h = collectReviewerHealth(fs, path, home, String(now));
  assert.equal(h.calls, 7);
  assert.equal(h.l2.judged, 3);
  assert.equal(h.l2.failed, 2, "a row older than 24 h does not count");
  assert.equal(h.l2.failedHour, 1);
  assert.deepEqual(h.l2.causes, { timeout: 1, "empty reply": 1 });
  assert.equal(h.decider.errors, 1);
  assert.equal(h.restriction.enforced, 1);
  assert.equal(h.restriction.shadowWouldDeny, 1);
  assert.match(h.view.fault, /the view file is gone/);
  const text = JSON.stringify(h);
  assert.ok(!text.includes("SECRET-PARAM") && !text.includes("SECRET-REASON"), "tool parameters and reasons stay in the bot");
  const st = healthStatus(h);
  assert.equal(st.status, "bad");
  assert.equal(healthStatus({ ...healthy(), l2: { ...healthy().l2, failed: 1 } }).status, "warn");
  assert.equal(healthStatus(null).status, "unknown");
  assert.equal(collectReviewerHealth(fs, path, tmp(), String(now)).error, "no audit yet");
});

test("readDaemonModes reads the two modes from the plist, and the defaults without one", () => {
  const dir = tmp();
  const file = path.join(dir, "a.plist");
  fs.writeFileSync(file, "<key>OASIS_AUTHORITY_AUTO</key>\n<string>enforce</string>\n<key>OASIS_AUTHORITY_GRANTS</key> <string>require</string>");
  assert.deepEqual(readDaemonModes(file), { auto: "enforce", grants: "require", plist: true });
  assert.deepEqual(readDaemonModes(path.join(dir, "none.plist")), { auto: "shadow", grants: "observe", plist: false });
});

// ── 5. routes ────────────────────────────────────────────────────────────────

async function authorityServer(s) {
  const ctx = {
    port: 0,
    token: "t".repeat(43),
    discover: async () => ({ bots: BOTS.map((b) => ({ ...b, controlUi: { url: null, via: "none" }, board: null })), proxy: null }),
    swarm: { port: 1, url: "http://127.0.0.1:1/" },
    inspectFor: (container) => (container === "oasis-claw-house" ? inspectWith("house") : null),
    authorityDir: s.dir,
    authorityViewDir: s.viewDir,
    authorityPlist: path.join(s.dir, "none.plist"),
    readReviewerHealth: async (b) => (b.key === "nimbus" ? Promise.reject(new Error("docker exec timed out")) : healthy()),
    rootSigner: async () => s.root,
  };
  const server = createObservatoryServer(ctx);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  ctx.port = server.address().port;
  const call = (pathname, method = "GET", body = null, { origin = true } = {}) =>
    new Promise((resolve, reject) => {
      const headers = { host: `127.0.0.1:${ctx.port}`, "x-observatory-token": ctx.token };
      if (method !== "GET" && origin) headers.origin = `http://127.0.0.1:${ctx.port}`;
      if (body) headers["content-type"] = "application/json";
      const req = http.request({ host: "127.0.0.1", port: ctx.port, path: pathname, method, headers, agent: false }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text, json: JSON.parse(text || "null") }));
      });
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("server: GET /api/authority gives the page model; one bot's health error does not fail the page", async () => {
  const s = await setup();
  await viewsFor(s);
  const srv = await authorityServer(s);
  try {
    const r = await srv.call("/api/authority");
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.instances.map((i) => i.key), ["house", "nimbus", "down"]);
    assert.equal(r.json.instances.find((i) => i.key === "nimbus").reviewer.status, "unknown");
    assert.equal(r.json.history[0].kind, "root.genesis");
    assert.ok(!r.text.includes("SECRET-TOKEN-VALUE"));
  } finally {
    await srv.close();
  }
});

test("server: a POST signs with the root key; without this page's Origin it is refused; GET of an action is refused", async () => {
  const s = await setup();
  const srv = await authorityServer(s);
  try {
    const body = { target: "agent:house", level: "chat-only", reason: "frozen by Mike from the observatory" };
    assert.equal((await srv.call("/api/authority/restrict", "POST", body, { origin: false })).status, 403);
    assert.equal((await srv.call("/api/authority/restrict")).status, 405);
    assert.equal((await srv.call("/api/authority", "POST", body)).status, 405, "the page model takes no write");
    const bad = await srv.call("/api/authority/restrict", "POST", { ...body, target: "agent:ghost" });
    assert.equal(bad.status, 400);
    assert.equal(loadAuthority(s.dir).streams.restrictions.events.length, 0);
    const ok = await srv.call("/api/authority/restrict", "POST", body);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.event.kind, "restriction.add");
    const lift = await srv.call("/api/authority/lift", "POST", { ids: [ok.json.event.id] });
    assert.equal(lift.status, 200, lift.text);
    assert.equal(loadAuthority(s.dir).streams.restrictions.events.length, 2);
  } finally {
    await srv.close();
  }
  const req = (method, url) => ({ method, url, headers: { host: "127.0.0.1:18780", origin: "http://127.0.0.1:18780" } });
  assert.equal(checkRequest(req("POST", "/api/authority/freeze"), 18780)?.status, 405, "only restrict, lift and keep write");
  assert.equal(checkRequest(req("PUT", "/api/authority/restrict"), 18780)?.status, 405);
  assert.equal(checkRequest(req("POST", "/api/authority/keep"), 18780), null);
});

test("the Access view names /reach/authority as the authority view, with no ~/Library flag", () => {
  const m = classifyMount(
    { Type: "bind", Source: "/host_mnt/Users/mike/Library/Application Support/oasis-x/authority-view/house", Destination: "/reach/authority", RW: false },
    { home: "/Users/mike", repoRoot: "/Users/mike/Documents/Runes/oasis-x/oasis-claw" },
  );
  assert.equal(m.kind, "authority view");
  assert.deepEqual(m.flags, []);
});

// ── 6. the daemon ────────────────────────────────────────────────────────────

test("the daemon sends a new root restriction to the bots without waiting for its interval", async () => {
  const s = await setup();
  const ledgerDir = tmp("authority-ledger-");
  const ledgerFile = path.join(ledgerDir, "peer-grants.json");
  fs.writeFileSync(ledgerFile, JSON.stringify({ grants: [] }));
  const rows = [];
  const d = await runDaemon(s.dir, { ledgerFile, viewDir: s.viewDir, fleet: BOTS.slice(0, 1), collect: async () => [], intervalMs: 3_600_000, log: (r) => rows.push(r) });
  try {
    const file = path.join(s.viewDir, "house", VIEW_FILE);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).restrictions.items.length, 0);
    // Real time here: the view's own clock must not matter for the watch.
    await appendEvent(s.dir, "restrictions", { kind: "restriction.add", scope: "agent:house", body: mikeBody("agent:house") }, s.root);
    const deadline = Date.now() + 5000;
    let items = 0;
    while (Date.now() < deadline) {
      items = JSON.parse(fs.readFileSync(file, "utf8")).restrictions.items.length;
      if (items) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(items, 1, "the view has the restriction within 5 s");
  } finally {
    d.stop();
  }
});
