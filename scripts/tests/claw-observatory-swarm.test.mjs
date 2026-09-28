// Tests for the observatory's supervision of the dot_swarm dashboard (CLAW-108).
//
// Load-bearing property: the observatory links to a `swarm gui` only after it
// proves the 2026-09-28 fix — the page carries no token, and a read without
// the token is refused. Any other dashboard is stopped at once, because a bot
// can reach its port through host.docker.internal.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseFlags, startSwarmDashboard, verifySwarmDashboard } from "../claw-observatory.mjs";

const TOKEN = "T".repeat(43);

// A stand-in for `swarm gui`. FAKE_MODE picks its behavior:
//   fixed     the 2026-09-28 behavior
//   leaky     puts the token in GET / (dot_swarm before the fix)
//   open      serves /api/state.json without the token (before the fix)
//   badtoken  refuses SWARM_GUI_TOKEN and exits 2, as dot_swarm does
const FAKE_SWARM = `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const token = process.env.SWARM_GUI_TOKEN || "";
const mode = process.env.FAKE_MODE || "fixed";
if (mode === "badtoken") {
  process.stderr.write("Error: SWARM_GUI_TOKEN must be at least 32 characters\\n");
  process.exit(2);
}
console.log("Open this URL: http://127.0.0.1:" + port + "/#t=" + token);
http.createServer((req, res) => {
  if (req.url === "/") {
    res.end(mode === "leaky" ? "<script>const T = '" + token + "'</script>" : "<title>dot_swarm Dashboard</title>");
    return;
  }
  if (req.url.startsWith("/api/")) {
    if (mode !== "open" && req.headers["x-swarm-token"] !== token) {
      res.statusCode = 401;
      res.end("{}");
      return;
    }
    res.end("{\\"divisions\\": []}");
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(port, "127.0.0.1");
`;

function fakeBin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-fake-swarm-"));
  const bin = path.join(dir, "swarm.cjs");
  fs.writeFileSync(bin, FAKE_SWARM, { mode: 0o755 });
  return bin;
}

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

const answers = (url) =>
  new Promise((resolve) => {
    const req = http.get(url, { timeout: 1000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });

async function waitUntilGone(url, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await answers(url))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const start = async (mode, extra = {}) =>
  startSwarmDashboard({
    bin: fakeBin(),
    root: os.tmpdir(),
    port: await freePort(),
    token: TOKEN,
    env: { ...process.env, FAKE_MODE: mode },
    timeoutMs: 10_000,
    ...extra,
  });

test("a fixed dashboard is started, verified, and linked with its token in the fragment", async () => {
  const d = await start("fixed");
  try {
    assert.equal(d.state, "managed", d.reason);
    assert.equal(d.openUrl, `${d.url}#t=${TOKEN}`);
    assert.equal(await verifySwarmDashboard(d.url, TOKEN), null);
  } finally {
    d.stop?.();
  }
  assert.ok(await waitUntilGone(d.url), "stop() must end the dashboard process");
});

test("a dashboard that puts the token in its page is refused and stopped", async () => {
  const d = await start("leaky");
  assert.equal(d.state, "failed");
  assert.match(d.reason, /hands out the session token/);
  assert.ok(!d.reason.includes(TOKEN), "the reason must not repeat the token");
  assert.ok(await waitUntilGone(d.url), "a refused dashboard must not keep running");
});

test("a dashboard that serves state without the token is refused and stopped", async () => {
  const d = await start("open");
  assert.equal(d.state, "failed");
  assert.match(d.reason, /without the token answered 200, not 401/);
  assert.ok(await waitUntilGone(d.url));
});

test("a dashboard that refuses the supplied token reports why", async () => {
  const d = await start("badtoken");
  assert.equal(d.state, "failed");
  assert.match(d.reason, /stopped \(exit 2\)/);
  assert.match(d.reason, /SWARM_GUI_TOKEN must be/);
});

test("a missing dot_swarm binary is a clean failure, not a crash", async () => {
  const d = await start("fixed", { bin: path.join(os.tmpdir(), "no-such-swarm-binary") });
  assert.equal(d.state, "failed");
  assert.match(d.reason, /ENOENT|stopped/);
});

test("a port that already answers is left alone and reported as foreign", async () => {
  const other = http.createServer((_req, res) => res.end("someone else"));
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  const port = other.address().port;
  try {
    const d = await start("fixed", { port });
    assert.equal(d.state, "foreign");
    assert.equal(d.url, `http://127.0.0.1:${port}/`);
    assert.equal(d.openUrl, undefined, "the observatory cannot know a foreign dashboard's token");
  } finally {
    await new Promise((r) => other.close(r));
  }
});

test("serve takes --no-dashboard", () => {
  assert.equal(parseFlags(["--no-dashboard"]).noDashboard, true);
  assert.equal(parseFlags([]).noDashboard, undefined);
});

// The real dot_swarm, when this Mac has it. Proves the fixed dashboard passes
// the same check that the fakes above fail.
const REAL_SWARM =
  process.env.OASIS_SWARM_BIN || path.join(os.homedir(), "Documents", "Runes", "dot_swarm", ".venv", "bin", "swarm");

test("the real dot_swarm dashboard passes the check", { skip: !fs.existsSync(REAL_SWARM) && `no dot_swarm at ${REAL_SWARM}` }, async () => {
  const { execFileSync } = await import("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obs-real-colony-"));
  execFileSync(REAL_SWARM, ["--path", root, "init"], { stdio: "ignore" });
  const d = await startSwarmDashboard({ bin: REAL_SWARM, root, port: await freePort(), token: TOKEN, timeoutMs: 30_000 });
  try {
    assert.equal(d.state, "managed", d.reason);
  } finally {
    d.stop?.();
  }
  assert.ok(await waitUntilGone(d.url));
});
