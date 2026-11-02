// Tests for the observatory Access view (2026-11-02). Run with:
//   node --test scripts/tests/claw-observatory*.test.mjs
// The role.yaml parser runs under python3 + PyYAML (the bot image has both).
// Its test runs only when OASIS_TEST_PYTHON names such an interpreter, for
// example a venv: python3 -m venv .venv && .venv/bin/pip install pyyaml.
//
// Load-bearing properties:
//   1. Only the environment names in ACCESS_ENV leave the module: a token in
//      a bot's environment never reaches the page.
//   2. The level (A, B, C or custom) follows the live settings, and full exec
//      without an enforcing reviewer is a high finding.
//   3. Drift compares role.yaml, the container and the live config: a missing
//      declared mount, a read-only declaration mounted read-write, a different
//      host path, a tools change that needs a restart.
//   4. A project mount from a protected place is flagged; the fleet's own
//      plumbing (mail, policy, role.yaml, GitHub token, approvals) is not.
//   5. The route only reads: no write method, and one bot's collector error
//      does not fail the others.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkRequest, collectorScript, createObservatoryServer } from "../claw-observatory.mjs";
import {
  ACCESS_ENV,
  ROLE_PY,
  accessEnv,
  accessLevel,
  classifyMount,
  collectAccessConfig,
  describeAccess,
  policyKey,
} from "../claw-observatory-access.mjs";

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const HOME = "/Users/mike";
const REPO = "/Users/mike/Documents/Runes/oasis-x/oasis-claw";
const SECRET = "sk-live-must-never-leave";

const LEVEL_A = {
  OASIS_EXEC_SECURITY: "full",
  OASIS_EXEC_MODE: "full",
  OASIS_EXEC_ASK: "off",
  OASIS_REVIEWER_MODE: "enforce",
  OASIS_REVIEWER_L2: "enforce",
  OASIS_REVIEWER_DECIDER: "shadow",
};

const bind = (dest, source, rw = false) => ({ Type: "bind", Source: source, Destination: dest, RW: rw });

function inspectFor({ name = "Mr. House", env = LEVEL_A, mounts = [] } = {}) {
  return {
    Name: "/oasis-claw-house",
    Config: {
      Env: [
        `OASIS_AGENT_NAME=${name}`,
        ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
        `OPENCLAW_GATEWAY_TOKEN=${SECRET}`,
        `OASIS_TELEGRAM_BOT_TOKEN=${SECRET}`,
      ],
    },
    Mounts: [
      { Type: "volume", Name: "oasis_openclaw_home_house", Destination: "/home/node/.openclaw", RW: true },
      bind("/app/role.yaml", `/host_mnt${REPO}/bots/house/role.yaml`),
      bind("/app/extensions/oasis-reviewer/policy/reviewer-policy.json", `${REPO}/bots/reviewer-policy.json`),
      bind("/reach/mail/inbox", "/Users/mike/Documents/Runes/.claw-mail/house/inbox"),
      bind("/run/oasis-gh", `${HOME}/Library/Application Support/oasis-x/gh-tokens/house`),
      ...mounts,
    ],
  };
}

const LIVE = {
  config: { toolsProfile: "coding", alsoAllow: ["sleep_deep", "reach_send"], execMode: "full", sandbox: {}, skipBootstrap: true },
  approvals: { security: "full", ask: "off", askFallback: "deny", allowlist: 22 },
  persona: { pinnedAt: "2026-11-02T18:00:00.000Z", files: 4, changes: 0, lastChange: null },
};

const DECLARED = {
  role: "market-analysis",
  phase: "analysis",
  tools: { profile: "coding", alsoAllow: ["sleep_deep"] },
  exec: { allow: 22, dormantTiers: [] },
  reach: {
    read: [
      { host: "/Users/mike/Documents/Runes/oasis-x/house-work", at: "/reach/house-work", mode: "ro" },
      { host: "/Users/mike/Documents/Knowledge", at: "/reach/knowledge", mode: "ro" },
    ],
    writeVolumes: [{ name: "house_report", at: "/report" }],
  },
};

const bot = { key: "house", container: "oasis-claw-house", running: true, state: "running" };
const describe = (overrides = {}) =>
  describeAccess({ bot, inspect: inspectFor(overrides.inspect), live: LIVE, declared: DECLARED, policy: overrides.policy ?? null, home: HOME, repoRoot: REPO, ...overrides.args });

test("accessEnv keeps only the named settings, never a token", () => {
  const env = accessEnv(inspectFor());
  assert.deepEqual(Object.keys(env).sort(), ["OASIS_AGENT_NAME", ...Object.keys(LEVEL_A)].sort());
  assert.ok(!JSON.stringify(env).includes(SECRET));
  assert.ok(ACCESS_ENV.every((k) => !/TOKEN|KEY|SECRET|PASSWORD/.test(k)), "a secret-looking name in ACCESS_ENV");
});

test("levels: A, B (fails closed), C (allowlist + SSH sandbox), custom with the gaps", () => {
  assert.equal(accessLevel(LEVEL_A, false).id, "A");
  assert.equal(accessLevel(LEVEL_A, true).id, "B");
  assert.equal(accessLevel({ ...LEVEL_A, OASIS_EXEC_SECURITY: "allowlist", OASIS_EXEC_MODE: "", OASIS_SANDBOX_SSH_SOCKET: "/run/sbx.sock" }, false).id, "C");
  const custom = accessLevel({ ...LEVEL_A, OASIS_REVIEWER_L2: "shadow" }, false);
  assert.equal(custom.id, "custom");
  assert.deepEqual(custom.gaps, ["Layer 2 is shadow, not enforce"]);
});

test("the policy key follows the reviewer's own rule, and fails-closed comes from the policy", () => {
  const policy = { botAliases: { "Odd Name": "house" }, hard: { per_bot: { house: { constitutionalReviewRequired: true, allowWriteRoots: ["/reach/house-work"] } } } };
  assert.equal(policyKey("Mr. House", null), "mrhouse");
  assert.equal(policyKey("Odd Name", policy), "house");
  const a = describe({ inspect: { name: "Odd Name" }, policy });
  assert.equal(a.level.id, "B");
  assert.equal(a.reviewer.failClosed, true);
  assert.deepEqual(a.reviewer.writeRoots, ["/reach/house-work"]);
});

test("full exec without an enforcing reviewer is a high finding", () => {
  const a = describe({ inspect: { env: { ...LEVEL_A, OASIS_REVIEWER_MODE: "shadow" } } });
  assert.equal(a.level.id, "custom");
  assert.ok(a.drift.some((d) => d.severity === "risk" && /without an enforcing reviewer/.test(d.text)));
});

test("mount drift: missing declared mount, ro declared but rw live, a different host, a missing volume", () => {
  const a = describe({
    inspect: {
      mounts: [
        bind("/reach/house-work", "/Users/mike/Documents/Runes/oasis-x/house-work-old", true),
        bind("/reach/extra", "/Users/mike/Documents/extra"),
      ],
    },
  });
  const texts = a.drift.map((d) => `${d.severity}:${d.text}`);
  assert.ok(texts.some((t) => t.startsWith("risk:/reach/house-work is read-write")));
  assert.ok(texts.some((t) => t.startsWith("warn:/reach/house-work comes from /Users/mike/Documents/Runes/oasis-x/house-work-old")));
  assert.ok(texts.some((t) => t.startsWith("warn:role.yaml declares /reach/knowledge")));
  assert.ok(texts.some((t) => t.startsWith("warn:role.yaml declares the volume house_report")));
  const extra = a.mounts.find((m) => m.at === "/reach/extra");
  assert.equal(extra.declared, false, "an overlay-only mount is marked, not reported as drift");
  assert.equal(a.mounts.find((m) => m.at === "/reach/mail/inbox").declared, null, "plumbing is not a role.yaml question");
});

test("tools drift and the exec allowlist that has no effect at security=full", () => {
  const a = describeAccess({
    bot,
    inspect: inspectFor(),
    live: { ...LIVE, config: { ...LIVE.config, toolsProfile: "messaging", alsoAllow: [] } },
    declared: DECLARED,
    home: HOME,
    repoRoot: REPO,
  });
  const texts = a.drift.map((d) => d.text);
  assert.ok(texts.some((t) => /tools\.profile coding; the running config has messaging/.test(t)));
  assert.ok(texts.some((t) => /allows sleep_deep; the running config does not/.test(t)));
  assert.ok(texts.some((t) => /22 exec\.allow patterns, but the bot runs security=full/.test(t)));
});

test("a bot that agrees with its role.yaml has no warnings", () => {
  const a = describe({
    inspect: {
      mounts: [
        bind("/reach/house-work", "/Users/mike/Documents/Runes/oasis-x/house-work"),
        bind("/reach/knowledge", "/Users/mike/Documents/Knowledge"),
        { Type: "volume", Name: "oasis_house_report", Destination: "/report", RW: true },
      ],
    },
  });
  assert.deepEqual(a.drift.filter((d) => d.severity !== "info"), []);
  assert.equal(a.persona.active, true);
});

test("mount flags: control plane (not .swarm), ~/.ssh, ~/.aws, ~/Library; plumbing is not flagged", () => {
  const flags = (dest, source, rw) => classifyMount(bind(dest, source, rw), { home: HOME, repoRoot: REPO }).flags;
  assert.deepEqual(flags("/reach/claw", `${REPO}/scripts`), ["oasis-claw control plane"]);
  assert.deepEqual(flags("/reach/claw-swarm", `${REPO}/.swarm`, true), [], "the shared work board is not the control plane");
  assert.deepEqual(flags("/reach/keys", `${HOME}/.ssh`), ["~/.ssh"]);
  assert.deepEqual(flags("/home/node/.aws", `${HOME}/.aws-house`), ["~/.aws"]);
  assert.deepEqual(flags("/reach/agents", `${HOME}/Library/LaunchAgents`, true), ["~/Library"]);
  assert.deepEqual(flags("/run/oasis-gh", `${HOME}/Library/Application Support/oasis-x/gh-tokens/house`), []);
  assert.deepEqual(flags("/reach/mail/inbox", "/x/.claw-mail/house/inbox"), []);
  assert.deepEqual(flags("/reach/mail-copy", "/x/.claw-mail/house/inbox"), [".claw-mail"]);
  const a = describe({ inspect: { mounts: [bind("/reach/agents", `${HOME}/Library/LaunchAgents`, true)] } });
  assert.ok(a.drift.some((d) => d.severity === "risk" && d.text.startsWith("/reach/agents is read-write")));
});

test("persona: an image without the check gives one note, not a warning", () => {
  const a = describeAccess({ bot, inspect: inspectFor(), live: { ...LIVE, config: { ...LIVE.config, skipBootstrap: false }, persona: { error: "missing" } }, declared: null, home: HOME, repoRoot: REPO });
  const persona = a.drift.filter((d) => d.area === "persona");
  assert.equal(persona.length, 1);
  assert.equal(persona[0].severity, "info");
  assert.equal(a.persona.active, false);
});

test("collectAccessConfig reads only the named keys, and never follows a symlink", () => {
  const home = tmp("access-home-");
  fs.writeFileSync(
    path.join(home, "openclaw.json"),
    JSON.stringify({
      gateway: { auth: { token: SECRET } },
      tools: { profile: "coding", alsoAllow: ["sleep_deep", 7], exec: { mode: "full" } },
      agents: { defaults: { skipBootstrap: true, sandbox: { mode: "all", backend: "ssh" } } },
    }),
  );
  fs.writeFileSync(path.join(home, "exec-approvals.json"), JSON.stringify({ defaults: { security: "full", ask: "off" }, agents: { main: { allowlist: [{ pattern: "ls" }, { pattern: "git" }] } } }));
  fs.writeFileSync(path.join(home, "persona.lock.json"), JSON.stringify({ version: 1, pinnedAt: "2026-11-02T18:00:00Z", files: { "SOUL.md": {} }, history: [{ at: "2026-11-03T00:00:00Z", file: "TOOLS.md" }] }));
  const out = collectAccessConfig(fs, path, home);
  assert.deepEqual(out.config, { toolsProfile: "coding", alsoAllow: ["sleep_deep"], execMode: "full", sandbox: { mode: "all", backend: "ssh", scope: null, workspaceAccess: null }, skipBootstrap: true });
  assert.deepEqual(out.approvals, { security: "full", ask: "off", askFallback: null, allowlist: 2 });
  assert.deepEqual(out.persona, { pinnedAt: "2026-11-02T18:00:00Z", files: 1, changes: 1, lastChange: { at: "2026-11-03T00:00:00Z", file: "TOOLS.md" } });
  assert.ok(!JSON.stringify(out).includes(SECRET));

  const other = tmp("access-link-");
  fs.symlinkSync(path.join(home, "openclaw.json"), path.join(other, "openclaw.json"));
  assert.match(collectAccessConfig(fs, path, other).config.error, /not a regular file/);
  assert.equal(collectAccessConfig(fs, path, other).persona.error, "missing");
  // It runs as a collector: self-contained, the way the server sends it.
  const viaNode = JSON.parse(execFileSync(process.execPath, ["-e", collectorScript(collectAccessConfig, home)], { encoding: "utf8" }));
  assert.deepEqual(viaNode, out);
});

test("ROLE_PY parses role.yaml the way the entrypoint's compiler does", { skip: !process.env.OASIS_TEST_PYTHON && "set OASIS_TEST_PYTHON to a python3 with PyYAML" }, () => {
  const dir = tmp("access-role-");
  const file = path.join(dir, "role.yaml");
  fs.writeFileSync(
    file,
    [
      "role: market-analysis   # comment",
      "phase: analysis",
      "tools:",
      "  profile: coding",
      "  alsoAllow: [sleep_deep]",
      "exec:",
      "  allow: [ls, cat]",
      "  dormant:",
      "    build: [make]",
      "reach:",
      "  read:",
      "    - { host: /a/work, at: /reach/work }",
      "    - { host: /a/out, at: /reach/out, mode: RW }",
      "    - { host: '', at: /reach/skip }",
      "  write_volumes:",
      "    - { name: house_report, at: /report }",
      "",
    ].join("\n"),
  );
  const out = JSON.parse(execFileSync(process.env.OASIS_TEST_PYTHON, ["-c", ROLE_PY, file], { encoding: "utf8" }));
  assert.deepEqual(out, {
    role: "market-analysis",
    phase: "analysis",
    tools: { profile: "coding", alsoAllow: ["sleep_deep"] },
    exec: { allow: 2, dormantTiers: ["build"] },
    reach: { read: [{ host: "/a/work", at: "/reach/work", mode: "ro" }, { host: "/a/out", at: "/reach/out", mode: "rw" }], writeVolumes: [{ name: "house_report", at: "/report" }] },
  });
  fs.writeFileSync(file, "role: [unclosed\n");
  assert.match(JSON.parse(execFileSync(process.env.OASIS_TEST_PYTHON, ["-c", ROLE_PY, file], { encoding: "utf8" })).error, /does not parse/);
});

// ── the server route ──────────────────────────────────────────────────────────

async function accessServer() {
  const calls = { config: [], role: [] };
  const inspects = {
    "oasis-claw-house": inspectFor({ mounts: [bind("/reach/house-work", "/Users/mike/Documents/Runes/oasis-x/house-work")] }),
    "oasis-claw-runtime": { ...inspectFor({ name: "Nimbus" }), Name: "/oasis-claw-runtime", Mounts: [{ Type: "volume", Name: "oasis_openclaw_home", Destination: "/home/node/.openclaw", RW: true }] },
    "oasis-claw-down": { ...inspectFor({ name: "Down" }), Name: "/oasis-claw-down" },
  };
  const ctx = {
    port: 0,
    token: "t".repeat(43),
    discover: async () => ({
      bots: [
        { key: "house", container: "oasis-claw-house", running: true, state: "running", controlUi: { url: null, via: "none" }, board: null },
        { key: "nimbus", container: "oasis-claw-runtime", running: true, state: "running", controlUi: { url: null, via: "none" }, board: null },
        { key: "down", container: "oasis-claw-down", running: false, state: "exited", controlUi: { url: null, via: "none" }, board: null },
      ],
      proxy: null,
    }),
    swarm: { port: 1, url: "http://127.0.0.1:1/" },
    inspectFor: (container) => inspects[container] ?? null,
    readAccessConfig: async (b) => {
      calls.config.push(b.key);
      if (b.key === "nimbus") throw new Error("docker exec timed out");
      return LIVE;
    },
    readRoleDeclared: async (b) => {
      calls.role.push(b.key);
      return DECLARED;
    },
    readPolicy: async () => ({ hard: { per_bot: { mrhouse: { allowWriteRoots: ["/reach/house-work"] } } } }),
  };
  const server = createObservatoryServer(ctx);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  ctx.port = server.address().port;
  const call = (pathname, method = "GET") =>
    new Promise((resolve, reject) => {
      const headers = { host: `127.0.0.1:${ctx.port}`, "x-observatory-token": ctx.token };
      if (method !== "GET") headers.origin = `http://127.0.0.1:${ctx.port}`;
      const req = http.request({ host: "127.0.0.1", port: ctx.port, path: pathname, method, headers, agent: false }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text, json: JSON.parse(text || "null") }));
      });
      req.on("error", reject);
      req.end();
    });
  return { call, calls, close: () => new Promise((r) => server.close(r)) };
}

test("server: GET /api/access gives every bot, keeps going past one bot's error, and never sends a token", async () => {
  const s = await accessServer();
  try {
    const r = await s.call("/api/access");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.bots.map((a) => a.key), ["house", "nimbus", "down"]);
    const house = r.json.bots[0];
    assert.equal(house.level.id, "A");
    assert.deepEqual(house.reviewer.writeRoots, ["/reach/house-work"]);
    assert.ok(house.drift.some((d) => /role\.yaml declares \/reach\/knowledge/.test(d.text)));
    assert.deepEqual(r.json.bots[1].errors, ["docker exec timed out"]);
    assert.equal(r.json.bots[1].role.present, false);
    assert.deepEqual(r.json.bots[2].drift, [], "a stopped bot gets no drift");
    assert.deepEqual(s.calls.config.sort(), ["house", "nimbus"], "no collector runs in a stopped container");
    assert.deepEqual(s.calls.role, ["house"], "role.yaml is read only where it is mounted");
    assert.ok(!r.text.includes(SECRET), "a token from a bot's environment reached the page");
  } finally {
    await s.close();
  }
});

test("server: the Access view takes no write method", async () => {
  const port = 18780;
  const req = (method) => ({ method, url: "/api/access", headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` } });
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal(checkRequest(req(method), port).status, 405);
  const s = await accessServer();
  try {
    assert.equal((await s.call("/api/access", "POST")).status, 405);
  } finally {
    await s.close();
  }
});
