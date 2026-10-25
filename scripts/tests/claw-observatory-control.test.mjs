// Tests for the observatory's decisions, cron, tools and egress routes (2026-10-25).
// Run with: node --test scripts/tests/claw-observatory*.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  collectAgentConfig,
  createObservatoryServer,
  cronEditArgs,
  egressActivity,
  identityStore,
  parseCliJson,
  readEgress,
  settingsStore,
  submitDecision,
  validateDecision,
} from "../claw-observatory.mjs";

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const ID = "5d124f5d-d3ef-4039-b556-4fc23b64d4d6";
const ALLOWED = ["oasis-generation/claude-sonnet-5-5", "oasis-generation/claude-haiku-4-5"];
const agentJob = { id: ID, payload: { kind: "agentTurn" } };
const mainJob = { id: ID, payload: { kind: "systemEvent" } };

test("validateDecision passes only known ops with checked fields", () => {
  assert.deepEqual(validateDecision({ op: "decide", id: "GRANT-0001", hours: 4 }), { op: "decide", id: "GRANT-0001", hours: 4 });
  assert.deepEqual(validateDecision({ op: "decide", id: "DIR-0002", hours: null }), { op: "decide", id: "DIR-0002", hours: null });
  assert.ok(validateDecision({ op: "decide", id: "GRANT-0001", hours: 0 }).error);
  assert.ok(validateDecision({ op: "decide", id: "../GRANT-1", hours: 1 }).error);
  assert.ok(validateDecision({ op: "renew", id: "GRANT-0001", hours: 24 }).error, "only a directive renews");
  assert.ok(validateDecision({ op: "gh-decide", id: "GH-0001", approve: "yes" }).error);
  assert.ok(validateDecision({ op: "approve-everything" }).error);
  assert.ok(validateDecision([]).error);
  const d = validateDecision({ op: "directive", bot: "house", goal: "Ship it", may: "", lane: "ops", ttl_hours: 72, extra: "dropped" });
  assert.deepEqual(d, { op: "directive", bot: "house", goal: "Ship it", lane: "ops", ttl_hours: 72 });
  assert.ok(validateDecision({ op: "directive", bot: "house", goal: " " }).error);
});

test("submitDecision returns the autoreviewer's result, and takes back an unanswered decision", async () => {
  const dir = tmp("obs-dec-");
  // A fake autoreviewer: answer every inbox file.
  const timer = setInterval(() => {
    for (const n of fs.readdirSync(path.join(dir, "inbox")).filter((x) => x.endsWith(".json"))) {
      const body = JSON.parse(fs.readFileSync(path.join(dir, "inbox", n), "utf8"));
      fs.writeFileSync(path.join(dir, "done", n), JSON.stringify({ ok: true, id: body.id, status: "active" }));
      fs.rmSync(path.join(dir, "inbox", n));
    }
  }, 20);
  fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
  fs.mkdirSync(path.join(dir, "done"), { recursive: true });
  try {
    assert.deepEqual(await submitDecision({ op: "decide", id: "GRANT-0001", hours: 1 }, { dir, waitMs: 2000 }), { ok: true, id: "GRANT-0001", status: "active" });
    assert.deepEqual(fs.readdirSync(path.join(dir, "done")), []);
  } finally {
    clearInterval(timer);
  }
  const r = await submitDecision({ op: "decide", id: "GRANT-0002", hours: 1 }, { dir, waitMs: 300 });
  assert.equal(r.ok, false);
  assert.match(r.error, /nothing was decided/);
  assert.deepEqual(fs.readdirSync(path.join(dir, "inbox")), [], "the unanswered decision is taken back");
});

test("cronEditArgs builds --flag=value argv and refuses what openclaw would misuse", () => {
  assert.deepEqual(cronEditArgs(agentJob, { model: ALLOWED[1] }, ALLOWED), { args: [`--model=${ALLOWED[1]}`] });
  assert.deepEqual(cronEditArgs(agentJob, { model: "" }, ALLOWED), { args: ["--clear-model"] });
  assert.match(cronEditArgs(agentJob, { model: "openai/gpt-9" }, ALLOWED).error, /allowed models/);
  assert.match(cronEditArgs(mainJob, { model: ALLOWED[0] }, ALLOWED).error, /chat model/);
  assert.deepEqual(cronEditArgs(agentJob, { enabled: false, name: "Weather" }, ALLOWED), { args: ["--disable", "--name=Weather"] });
  assert.deepEqual(cronEditArgs(mainJob, { text: "--help me" }, ALLOWED), { args: ["--system-event=--help me"] });
  assert.deepEqual(cronEditArgs(agentJob, { schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "America/New_York" } }, ALLOWED), {
    args: ["--cron=0 8 * * 1-5", "--tz=America/New_York"],
  });
  assert.ok(cronEditArgs(agentJob, { schedule: { kind: "cron", expr: "0 8 * *; rm -rf /" } }, ALLOWED).error);
  assert.deepEqual(cronEditArgs(agentJob, { schedule: { kind: "every", every: "30m" } }, ALLOWED), { args: ["--every=30m"] });
  assert.ok(cronEditArgs(agentJob, { name: "a\nb" }, ALLOWED).error);
  assert.ok(cronEditArgs(agentJob, { thinking: "turbo" }, ALLOWED).error);
  assert.ok(cronEditArgs(agentJob, { owner: "x" }, ALLOWED).error);
  assert.ok(cronEditArgs(agentJob, {}, ALLOWED).error);
});

test("parseCliJson skips the CLI's warning lines", () => {
  assert.deepEqual(parseCliJson('Config warnings:\n- plugins.deny: plugin not found: codex\n{"jobs":[]}\n'), { jobs: [] });
  assert.throws(() => parseCliJson("no json here"));
});

test("collectAgentConfig reads models and tools, and its fingerprint follows the file", () => {
  const home = tmp("obs-home-");
  const write = (c) => fs.writeFileSync(path.join(home, "openclaw.json"), JSON.stringify(c));
  write({ agents: { defaults: { model: { primary: "a/x", fallbacks: ["a/y"] }, models: { "a/y": {}, "a/x": {} } } }, tools: { profile: "coding", alsoAllow: ["t1"] }, plugins: { entries: { p: { enabled: false } } } });
  const one = collectAgentConfig(fs, path, home);
  assert.deepEqual(one.model, { primary: "a/x", fallbacks: ["a/y"], subagents: null, allowed: ["a/x", "a/y"] });
  assert.deepEqual(one.tools.plugins, [{ id: "p", enabled: false }]);
  assert.equal(collectAgentConfig(fs, path, home).fingerprint, one.fingerprint);
  write({ agents: { defaults: { model: { primary: "a/z" } } } });
  assert.notEqual(collectAgentConfig(fs, path, home).fingerprint, one.fingerprint);
});

test("egress: per-bot activity from the audit tail and the list files", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  const rows = [
    { event: "decision", bot: "house", host: "api.telegram.org", action: "allow", ts_unix: now / 1000 - 60 },
    { event: "decision", bot: "house", host: "evil.example", action: "deny", ts_unix: now / 1000 - 30 },
    { event: "decision", bot: "yesman", host: "api.telegram.org", action: "allow", ts_unix: now / 1000 },
    { event: "decision", bot: "house", host: "old.example", action: "allow", ts_unix: now / 1000 - 30 * 86400 },
  ];
  assert.deepEqual(egressActivity(rows, "house", now).map((a) => [a.host, a.allow, a.deny]), [["evil.example", 0, 1], ["api.telegram.org", 1, 0]]);
  const dir = tmp("obs-egress-");
  fs.mkdirSync(path.join(dir, "learned", "house"), { recursive: true });
  fs.writeFileSync(path.join(dir, "allowlist.txt"), "# comment\n.anthropic.com\n");
  fs.writeFileSync(path.join(dir, "learned", "allowlist.txt"), "registry.npmjs.org\n");
  fs.writeFileSync(path.join(dir, "learned", "house", "allowlist.txt"), "api.coingecko.com\n");
  fs.writeFileSync(path.join(dir, "learned", "house", "learned.jsonl"), JSON.stringify({ ts: "2026-10-20T00:00:00Z", host: "api.coingecko.com", decision: "allow", reason: "ok" }) + "\n");
  const botsFile = path.join(dir, "bots.json");
  fs.writeFileSync(botsFile, JSON.stringify(["house"]));
  const e = readEgress("house", rows, { dir, botsFile, baseEnv: ["api.telegram.org", ".anthropic.com"] });
  assert.equal(e.behindProxy, true);
  assert.deepEqual(e.base, [".anthropic.com", "api.telegram.org"]);
  assert.deepEqual(e.learnedShared, ["registry.npmjs.org"]);
  assert.deepEqual(e.learnedBot, ["api.coingecko.com"]);
  assert.equal(e.decisions[0].host, "api.coingecko.com");
  assert.equal(readEgress("nimbus", null, { dir, botsFile }).behindProxy, false);
});

test("the cron and decide routes: token, Origin, argv, and the openclaw.json guard", async () => {
  const bot = { key: "house", container: "oasis-claw-house", running: true, state: "running" };
  const cli = [];
  const decisions = [];
  let fingerprint = "1:1";
  let driftOnce = false;
  const job = { id: ID, name: "Morning", enabled: true, schedule: { kind: "cron", expr: "0 7 * * *" }, sessionTarget: "isolated", payload: { kind: "agentTurn", message: "hi" }, state: {} };
  const ctx = {
    token: "t".repeat(32),
    discover: async () => ({ bots: [bot], proxy: null }),
    swarm: { port: 1, url: "http://127.0.0.1:1/" },
    snapshotDir: tmp("obs-empty-"),
    mailRoot: tmp("obs-mail-empty-"),
    identities: identityStore(tmp("obs-ident-")),
    readIdentity: async () => ({ name: null, role: null, avatar: null }),
    settings: settingsStore(path.join(tmp("obs-set-"), "settings.json")),
    readAgentConfig: async () => ({ fingerprint, model: { primary: ALLOWED[0], fallbacks: [], subagents: null, allowed: ALLOWED }, tools: {} }),
    cronCli: async (_bot, args) => {
      cli.push(args);
      if (args[0] === "list") return `Config warnings:\n{"jobs":[${JSON.stringify(job)}]}`;
      if (driftOnce) {
        fingerprint = "2:2";
        driftOnce = false;
      }
      return "ok";
    },
    submitDecision: async (body) => (decisions.push(body), { ok: true, id: body.id, status: "active" }),
  };
  const server = createObservatoryServer(ctx);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  ctx.port = server.address().port;
  const own = `http://127.0.0.1:${ctx.port}`;
  const call = (pathname, { method = "GET", body, origin = own, token = ctx.token } = {}) =>
    new Promise((resolve, reject) => {
      const headers = { host: `127.0.0.1:${ctx.port}`, "x-observatory-token": token };
      if (method !== "GET" && origin) headers.origin = origin;
      if (body !== undefined) headers["content-type"] = "application/json";
      const r = http.request({ host: "127.0.0.1", port: ctx.port, path: pathname, method, headers, agent: false }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(text || "null") }));
      });
      r.on("error", reject);
      r.end(body);
    });
  const edit = (patch, opts) => call(`/api/cron/house/${ID}`, { method: "POST", body: JSON.stringify({ action: "edit", patch }), ...opts });
  try {
    const list = await call("/api/cron");
    assert.equal(list.status, 200);
    assert.equal(list.json.bots[0].jobs[0].payload.text, "hi");
    assert.equal(list.json.bots[0].model.primary, ALLOWED[0]);

    assert.equal((await edit({ model: ALLOWED[1] }, { token: "x" })).status, 401);
    assert.equal((await edit({ model: ALLOWED[1] }, { origin: null })).status, 403);
    assert.equal((await edit({ model: ALLOWED[1] }, { origin: "http://evil.example" })).status, 403);
    const ok = await edit({ model: ALLOWED[1] });
    assert.equal(ok.status, 200);
    assert.deepEqual(cli.find((a) => a[0] === "edit"), ["edit", ID, `--model=${ALLOWED[1]}`]);
    assert.equal((await edit({ model: "openai/gpt-9" })).status, 400);
    assert.equal((await call(`/api/cron/house/${ID.replace("5d", "6d")}`, { method: "POST", body: JSON.stringify({ action: "run" }) })).status, 404);
    assert.equal((await call(`/api/cron/house/${ID}`, { method: "PUT", body: "{}" })).status, 405);

    driftOnce = true;
    const drift = await edit({ enabled: false });
    assert.equal(drift.status, 500);
    assert.match(drift.json.error, /openclaw\.json CHANGED/);

    const dec = await call("/api/approvals/decide", { method: "POST", body: JSON.stringify({ op: "decide", id: "DIR-0003", hours: 168 }) });
    assert.equal(dec.status, 200);
    assert.deepEqual(decisions, [{ op: "decide", id: "DIR-0003", hours: 168 }]);
    assert.equal((await call("/api/approvals/decide", { method: "POST", body: JSON.stringify({ op: "decide", id: "DIR-0003", hours: 999 }) })).status, 400);
    assert.equal((await call("/api/approvals/decide", { method: "POST", origin: null, body: "{}" })).status, 403);
    assert.equal(decisions.length, 1);
  } finally {
    server.close();
  }
});
