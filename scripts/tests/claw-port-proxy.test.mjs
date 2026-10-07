// Tests for the CLAW-108 port proxy.
//
// Load-bearing properties:
//   1. Nothing reaches a gateway until the client presents the access key.
//   2. The proxy maps ONLY its own loopback Origin to the origin the gateway
//      allows. Any other Origin reaches the gateway unchanged, or the gateway's
//      browser-origin check stops protecting anything.
//   3. The gateway never sees the proxy's key or a client-supplied forwarding
//      header.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import {
  COOKIE_NAME,
  UNLOCK_PATH,
  cookieKey,
  keyMatches,
  parseOriginTo,
  parseRoutes,
  readAccessKey,
  rewriteHeaders,
  startRoute,
} from "../claw-port-proxy.mjs";

const ORIGIN_TO = "http://127.0.0.1:18789";
const KEY = "k".repeat(43);
const KEY_COOKIE = `${COOKIE_NAME}=${KEY}`;

test("parseRoutes accepts a list and rejects malformed entries", () => {
  assert.deepEqual(parseRoutes("18891=oasis-claw-house:18789, 18896=host.docker.internal:18796"), [
    { listenPort: 18891, targetHost: "oasis-claw-house", targetPort: 18789 },
    { listenPort: 18896, targetHost: "host.docker.internal", targetPort: 18796 },
  ]);
  assert.throws(() => parseRoutes(""), /empty/);
  assert.throws(() => parseRoutes("18891=house"), /invalid route/);
  assert.throws(() => parseRoutes("0=house:18789"), /invalid listen port/);
  assert.throws(() => parseRoutes("18891=house:70000"), /invalid target port/);
  assert.throws(() => parseRoutes("18891=bad host:18789"), /invalid route|invalid target host/);
  assert.throws(() => parseRoutes("18891=-house:18789"), /invalid target host/);
  assert.throws(() => parseRoutes("18891=a:1,18891=b:2"), /duplicate/);
});

test("parseOriginTo accepts only a bare origin", () => {
  assert.equal(parseOriginTo("http://127.0.0.1:18789"), "http://127.0.0.1:18789");
  assert.throws(() => parseOriginTo("http://127.0.0.1:18789/path"), /invalid/);
  assert.throws(() => parseOriginTo("*"), /invalid/);
});

test("readAccessKey, keyMatches and cookieKey", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-key-"));
  const file = path.join(dir, "key");
  fs.writeFileSync(file, `${KEY}\n`);
  assert.equal(readAccessKey(file), KEY);
  fs.writeFileSync(file, "short");
  assert.throws(() => readAccessKey(file), /32 to 256/);
  assert.throws(() => readAccessKey(""), /required/);
  assert.ok(keyMatches(KEY, KEY));
  assert.ok(!keyMatches(`${KEY}x`, KEY));
  assert.ok(!keyMatches(null, KEY));
  assert.ok(!keyMatches("bad key with spaces", KEY));
  assert.equal(cookieKey(["Cookie", `a=1; ${KEY_COOKIE}; b=2`]), KEY);
  assert.equal(cookieKey(["cookie", "a=1"]), null);
  assert.equal(cookieKey([]), null);
});

test("rewriteHeaders maps only this listener's own loopback origin", () => {
  const rewrite = (origin) => rewriteHeaders(["Host", "127.0.0.1:18891", "Origin", origin], 18891, ORIGIN_TO)[3];
  assert.equal(rewrite("http://127.0.0.1:18891"), ORIGIN_TO);
  assert.equal(rewrite("http://localhost:18891"), ORIGIN_TO);
  for (const foreign of [
    "https://evil.example",
    "http://evil.example:18891",
    "http://127.0.0.1:18892",
    "http://127.0.0.1:3000",
    "https://127.0.0.1:18891",
    "http://127.0.0.2:18891",
    "null",
  ]) {
    assert.equal(rewrite(foreign), foreign, foreign);
  }
});

test("rewriteHeaders keeps Host and other cookies, strips forwarding headers and the proxy key", () => {
  const out = rewriteHeaders(
    [
      "Host", "127.0.0.1:18891",
      "X-Forwarded-For", "127.0.0.1",
      "forwarded", "for=127.0.0.1",
      "X-Real-IP", "127.0.0.1",
      "Cookie", `a=1; ${KEY_COOKIE}; b=2`,
    ],
    18891,
    ORIGIN_TO,
  );
  assert.deepEqual(out, ["Host", "127.0.0.1:18891", "Cookie", "a=1; b=2"]);
  assert.deepEqual(rewriteHeaders(["Cookie", KEY_COOKIE], 18891, ORIGIN_TO), [], "a cookie header holding only the key is dropped");
});

test("startRoute refuses to start without a valid access key", async () => {
  await assert.rejects(
    startRoute({ listenHost: "127.0.0.1", listenPort: 0, targetHost: "127.0.0.1", targetPort: 9, originTo: ORIGIN_TO }),
    /accessKey/,
  );
});

async function withUpstream(fn) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ kind: "http", origin: req.headers.origin, host: req.headers.host, xff: req.headers["x-forwarded-for"], cookie: req.headers.cookie });
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`echo:${body}`);
    });
  });
  upstream.on("upgrade", (req, socket) => {
    seen.push({ kind: "upgrade", origin: req.headers.origin, cookie: req.headers.cookie });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk) => socket.write(`pong:${chunk}`));
    // Upgraded http.Server sockets are half-open capable; answer a FIN.
    socket.on("end", () => socket.end());
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const { server, port } = await startRoute({
    listenHost: "127.0.0.1",
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: upstream.address().port,
    originTo: ORIGIN_TO,
    accessKey: KEY,
  });
  try {
    await fn({ port, seen });
  } finally {
    server.close();
    upstream.close();
  }
}

function request(port, { method = "GET", pathname = "/", origin, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: pathname, headers: { ...(origin ? { origin } : {}), ...headers }, agent: false },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, data }));
      },
    );
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function rawUpgrade(port, extraHeaders) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${extraHeaders}Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("101 Switching") && !data.includes("pong:")) {
        socket.write("ping");
      }
      if (data.includes("pong:ping")) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

test("locked: no key, wrong key → 403 and the gateway sees nothing", async () => {
  await withUpstream(async ({ port, seen }) => {
    assert.equal((await request(port, {})).status, 403);
    assert.equal((await request(port, { headers: { cookie: `${COOKIE_NAME}=${"x".repeat(43)}` } })).status, 403);
    const reply = await rawUpgrade(port, `Origin: http://127.0.0.1:${port}\r\n`);
    assert.match(reply, /403 Forbidden/);
    assert.equal(seen.length, 0);
  });
});

test("HTTP unlocked: own origin rewritten, foreign origin kept, body forwarded, key stripped", async () => {
  await withUpstream(async ({ port, seen }) => {
    const own = await request(port, {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: "hi",
      headers: { "x-forwarded-for": "127.0.0.1", cookie: `a=1; ${KEY_COOKIE}` },
    });
    assert.equal(own.status, 200);
    assert.equal(own.data, "echo:hi");
    const foreign = await request(port, { origin: "https://evil.example", headers: { cookie: KEY_COOKIE } });
    assert.equal(foreign.status, 200);
    assert.equal(seen[0].origin, ORIGIN_TO);
    assert.equal(seen[0].host, `127.0.0.1:${port}`);
    assert.equal(seen[0].xff, undefined);
    assert.equal(seen[0].cookie, "a=1");
    assert.equal(seen[1].origin, "https://evil.example");
    assert.equal(seen[1].cookie, undefined);
  });
});

test("WebSocket unlocked: origin rewritten, key stripped, bytes flow both ways", async () => {
  await withUpstream(async ({ port, seen }) => {
    const reply = await rawUpgrade(port, `Origin: http://localhost:${port}\r\nCookie: ${KEY_COOKIE}\r\n`);
    assert.match(reply, /101 Switching Protocols/);
    assert.match(reply, /pong:ping/);
    assert.equal(seen[0].kind, "upgrade");
    assert.equal(seen[0].origin, ORIGIN_TO);
    assert.equal(seen[0].cookie, undefined);
  });
});

test("unlock: page carries a nonce CSP; POST needs own origin and the key; cookie then works", async () => {
  await withUpstream(async ({ port, seen }) => {
    const page = await request(port, { pathname: `${UNLOCK_PATH}` });
    assert.equal(page.status, 200);
    const csp = page.headers["content-security-policy"];
    const nonce = csp.match(/'nonce-([^']+)'/)[1];
    assert.ok(page.data.includes(`nonce="${nonce}"`));
    assert.ok(!/unsafe-inline'[^;]*script|script-src[^;]*unsafe-inline/.test(csp));

    const own = `http://127.0.0.1:${port}`;
    assert.equal((await request(port, { method: "POST", pathname: UNLOCK_PATH, origin: own, body: "y".repeat(43) })).status, 403);
    assert.equal((await request(port, { method: "POST", pathname: UNLOCK_PATH, origin: "https://evil.example", body: KEY })).status, 403);
    assert.equal((await request(port, { method: "POST", pathname: UNLOCK_PATH, body: KEY })).status, 403, "no Origin at all is refused");
    assert.equal((await request(port, { method: "PUT", pathname: UNLOCK_PATH, origin: own, body: KEY })).status, 405);

    const ok = await request(port, { method: "POST", pathname: UNLOCK_PATH, origin: own, body: KEY });
    assert.equal(ok.status, 204);
    const setCookie = ok.headers["set-cookie"][0];
    assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=${KEY};`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.equal(seen.length, 0, "unlocking never touches the gateway");

    const cookie = setCookie.split(";")[0];
    assert.equal((await request(port, { headers: { cookie } })).status, 200);
  });
});

test("an unreachable target yields 502, not a hang", async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const deadPort = blocker.address().port;
  await new Promise((resolve) => blocker.close(resolve));
  const { server, port } = await startRoute({
    listenHost: "127.0.0.1",
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: deadPort,
    originTo: ORIGIN_TO,
    accessKey: KEY,
  });
  try {
    const res = await request(port, { headers: { cookie: KEY_COOKIE } });
    assert.equal(res.status, 502);
  } finally {
    server.close();
  }
});

test("unlock page: hands a gateway token on to the Control UI in the fragment only", async () => {
  await withUpstream(async ({ port }) => {
    const page = await request(port, { pathname: UNLOCK_PATH });
    const script = page.data.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
    const run = async (hash, ok = true) => {
      const seen = { replaced: null, cleaned: null, posted: null };
      const sandbox = {
        location: { hash, pathname: UNLOCK_PATH, replace: (u) => (seen.replaced = u) },
        history: { replaceState: (_s, _t, u) => (seen.cleaned = u) },
        document: { getElementById: () => ({ textContent: "" }) },
        fetch: async (_u, init) => {
          seen.posted = init.body;
          return { ok, status: ok ? 204 : 403 };
        },
      };
      vm.runInNewContext(script, sandbox);
      await new Promise((r) => setImmediate(r));
      return seen;
    };
    const gw = "a1".repeat(32);
    const withToken = await run(`#k=${KEY}&token=${gw}`);
    assert.equal(withToken.cleaned, UNLOCK_PATH, "the address bar loses the key and the token at once");
    assert.equal(withToken.posted, KEY, "only the key goes to the proxy");
    assert.equal(withToken.replaced, `/chat?session=main#token=${gw}`);
    assert.equal((await run(`#k=${KEY}`)).replaced, "/", "no token: the old landing page");
    assert.equal((await run(`#k=${KEY}&token=bad"<x>`)).replaced, "/", "a malformed token is dropped");
    assert.equal((await run(`#k=${KEY}&token=${gw}`, false)).replaced, null, "a refused key goes nowhere");
  });
});
