// Tests for the Mac GitHub minter and the in-bot token helpers (Mike,
// 2026-10-08: "GitHub App + Mac minter"). A fake GitHub API checks the App
// JWT signature and records each mint. Run with:
//   node --test scripts/tests/claw-gh-minter.test.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MINTER = path.join(ROOT, "claw-gh-minter");
const HELPER = path.join(ROOT, "git-policy", "git-credential-oasis-gh-file");
const GH_WRAPPER = path.join(ROOT, "git-policy", "gh-oasis");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function fakeGitHub(publicKey) {
  const mints = [];
  const revoked = [];
  const installs = {
    MikeHLee: { id: 11, repository_selection: "selected", repos: ["exp", "ai_research"] },
    "oasis-main": { id: 22, repository_selection: "all", repos: ["oasis-claw", "oasis-firmware"] },
  };
  const verifyJwt = (auth) => {
    const jwt = String(auth ?? "").replace(/^Bearer /, "");
    const [h, p, s] = jwt.split(".");
    if (!s) return null;
    const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"));
    return ok ? JSON.parse(Buffer.from(p, "base64url")) : null;
  };
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(obj === undefined ? "" : JSON.stringify(obj));
      };
      const m = req.url.match(/^\/users\/([^/]+)\/installation$/);
      if (m && req.method === "GET") {
        if (!verifyJwt(req.headers.authorization)) return send(401, { message: "bad jwt" });
        const inst = installs[m[1]];
        return inst ? send(200, { id: inst.id, repository_selection: inst.repository_selection }) : send(404, { message: "Not Found" });
      }
      const t = req.url.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
      if (t && req.method === "POST") {
        const claims = verifyJwt(req.headers.authorization);
        if (!claims || claims.iss !== "4242") return send(401, { message: "bad jwt" });
        const reqBody = JSON.parse(body || "{}");
        const inst = Object.values(installs).find((i) => String(i.id) === t[1]);
        const token = `ghs_test${++n}`;
        mints.push({ inst: inst.id, token, ...reqBody });
        const out = { token, expires_at: new Date(Date.now() + 3600e3).toISOString().replace(/\.\d+Z$/, "Z"), permissions: reqBody.permissions };
        if (reqBody.repositories) out.repositories = reqBody.repositories.map((name) => ({ name }));
        return send(201, out);
      }
      if (req.url.startsWith("/installation/repositories") && req.method === "GET") {
        const tok = String(req.headers.authorization).replace(/^token /, "");
        const mint = mints.find((x) => x.token === tok);
        const inst = Object.values(installs).find((i) => i.id === mint?.inst);
        return send(200, { repositories: (inst?.repos ?? []).map((name) => ({ name })) });
      }
      if (req.url === "/installation/token" && req.method === "DELETE") {
        revoked.push(String(req.headers.authorization).replace(/^token /, ""));
        return send(204);
      }
      send(404, { message: "Not Found" });
    });
  });
  return { server, mints, revoked };
}

function runMinter(args, env) {
  return new Promise((resolve) => {
    const child = spawn("python3", [MINTER, ...args], { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const helperGet = (dir, input) =>
  execFileSync("python3", [HELPER, "get"], { input, env: { ...process.env, OASIS_GH_TOKEN_DIR: dir } }).toString();

test("minter: signs with the App key, cuts each token to the bot's repos and permissions, writes mode 600", async () => {
  const support = tmp("gh-minter-");
  const keyDir = path.join(support, "github-app", "keys");
  fs.mkdirSync(keyDir, { recursive: true });
  const keyPath = path.join(keyDir, "test.pem");
  execFileSync("openssl", ["genrsa", "-out", keyPath, "2048"], { stdio: "ignore" });
  const publicKey = crypto.createPublicKey(fs.readFileSync(keyPath));
  const apps = { MikeHLee: { app_id: 4242, slug: "t", key: keyPath }, "oasis-main": { app_id: 4242, slug: "t", key: keyPath } };
  fs.writeFileSync(path.join(support, "github-app", "apps.json"), JSON.stringify(apps));
  const grants = {
    bots: {
      house: { MikeHLee: { repos: ["exp", "not-installed"], permissions: { contents: "write", metadata: "read", administration: "write" } } },
      yesman: { "oasis-main": { repos: "*", permissions: { contents: "write", metadata: "read" } } },
      ghost: { Nobody: { repos: "*" } },
    },
  };
  fs.writeFileSync(path.join(support, "github-app", "grants.json"), JSON.stringify(grants));
  const { server, mints, revoked } = fakeGitHub(publicKey);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = { OASIS_GH_SUPPORT_DIR: support, OASIS_GH_API: `http://127.0.0.1:${server.address().port}` };
  try {
    const run = await runMinter(["mint"], env);
    assert.match(run.out, /house\/MikeHLee: not in the App installation, skipped: not-installed/);
    assert.match(run.out, /ghost\/Nobody: no App for this account; skipped/);
    assert.ok(!/ghs_test/.test(run.out), "no token ever printed");

    const houseMint = mints.find((m) => m.inst === 11 && m.repositories);
    assert.deepEqual(houseMint.repositories, ["exp"]);
    assert.deepEqual(houseMint.permissions, { contents: "write", metadata: "read" }, "administration is not an App permission, so it is dropped");
    const yesMint = mints.find((m) => m.inst === 22);
    assert.equal(yesMint.repositories, undefined, "'*' asks for every repo the installation has");

    const houseFile = path.join(support, "gh-tokens", "house", "mikehlee.json");
    assert.equal(fs.statSync(houseFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(houseFile)).mode & 0o777, 0o700);
    const rec = JSON.parse(fs.readFileSync(houseFile, "utf8"));
    assert.deepEqual(rec.repositories, ["exp"]);

    // The in-bot helper serves that token for MikeHLee repos only.
    const dir = path.dirname(houseFile);
    assert.match(helperGet(dir, "protocol=https\nhost=github.com\npath=MikeHLee/exp.git\n\n"), new RegExp(`password=${rec.token}`));
    assert.equal(helperGet(dir, "protocol=https\nhost=github.com\npath=oasis-main/oasis-claw\n\n"), "", "no token for another account");
    assert.equal(helperGet(dir, "protocol=https\nhost=gitlab.com\npath=MikeHLee/exp\n\n"), "", "github.com only");
    assert.match(helperGet(dir, "protocol=https\nhost=github.com\n\n"), /password=/, "one token, no path: that token");

    // An expired token is never served.
    fs.writeFileSync(path.join(dir, "mikehlee.json"), JSON.stringify({ ...rec, expires_at: "2020-01-01T00:00:00Z" }));
    assert.equal(helperGet(dir, "protocol=https\nhost=github.com\npath=MikeHLee/exp\n\n"), "");
    fs.writeFileSync(path.join(dir, "mikehlee.json"), JSON.stringify(rec));

    // The gh wrapper picks the token by --repo, by an api path, or not at all.
    const fakeGh = path.join(support, "fake-gh");
    fs.writeFileSync(fakeGh, '#!/bin/sh\necho "token=${GH_TOKEN:-none} args=$*"\n', { mode: 0o755 });
    const gh = (args, extra = {}) =>
      execFileSync("sh", [GH_WRAPPER, ...args], { cwd: support, env: { ...process.env, OASIS_GH_REAL: fakeGh, OASIS_GH_FILE_HELPER: HELPER, OASIS_GH_TOKEN_DIR: dir, GH_TOKEN: "", ...extra } }).toString().trim();
    assert.equal(gh(["pr", "list", "-R", "MikeHLee/exp"]), `token=${rec.token} args=pr list -R MikeHLee/exp`);
    assert.equal(gh(["api", "repos/MikeHLee/exp/pulls"]), `token=${rec.token} args=api repos/MikeHLee/exp/pulls`);
    assert.equal(gh(["pr", "list", "--repo=oasis-main/oasis-claw"]), "token=none args=pr list --repo=oasis-main/oasis-claw");
    assert.equal(gh(["pr", "list"], { GH_TOKEN: "ghp_explicit" }), "token=ghp_explicit args=pr list", "a token in the env wins");

    // Revoke ends the token on GitHub and deletes the file.
    const rv = await runMinter(["revoke", "--bot", "house"], env);
    assert.match(rv.out, /revoke HTTP 204/);
    assert.ok(revoked.includes(rec.token));
    assert.ok(!fs.existsSync(houseFile));
  } finally {
    server.close();
  }
});
