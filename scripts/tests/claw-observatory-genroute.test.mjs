// Tests for the oasis-generation route switch in the observatory (GEN-008).
// Run with: node --test scripts/tests/claw-observatory*.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createObservatoryServer, genAdmin, identityStore, settingsStore } from "../claw-observatory.mjs";

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("genAdmin sends the file token, never returns it, and maps gateway errors", async () => {
  const dir = tmp("obs-gen-");
  const tokenFile = path.join(dir, "admin-token");
  fs.writeFileSync(tokenFile, "s3cret\n");
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (init.method === "PUT") return new Response(JSON.stringify({ detail: "no remote gateway is configured on this gateway" }), { status: 409 });
    return new Response(JSON.stringify({ clients: { house: "local" }, remote_configured: false }), { status: 200 });
  };
  const [s1, body1] = await genAdmin("GET", "/admin/routing", undefined, { url: "http://g", tokenFile, fetchImpl });
  assert.equal(s1, 200);
  assert.equal(seen[0].init.headers.authorization, "Bearer s3cret");
  assert.ok(!JSON.stringify(body1).includes("s3cret"));
  const [s2, body2] = await genAdmin("PUT", "/admin/routing/house", { target: "remote" }, { url: "http://g", tokenFile, fetchImpl });
  assert.equal(s2, 409);
  assert.match(body2.error, /no remote gateway/);
  const [s3] = await genAdmin("GET", "/admin/routing", undefined, { url: "http://g", tokenFile: path.join(dir, "missing"), fetchImpl });
  assert.equal(s3, 503);
  const [s4, body4] = await genAdmin("GET", "/admin/routing", undefined, {
    url: "http://g", tokenFile, fetchImpl: async () => { throw new TypeError("fetch failed"); },
  });
  assert.equal(s4, 502);
  assert.ok(!JSON.stringify(body4).includes("s3cret"));
});

test("/api/genroute reads and switches through ctx.genAdmin, with the page's write checks", async () => {
  const calls = [];
  const ctx = {
    token: "t".repeat(32),
    discover: async () => ({ bots: [], proxy: null }),
    swarm: { port: 1, url: "http://127.0.0.1:1/" },
    snapshotDir: tmp("obs-empty-"),
    mailRoot: tmp("obs-mail-empty-"),
    identities: identityStore(tmp("obs-ident-")),
    readIdentity: async () => ({ name: null, role: null, avatar: null }),
    settings: settingsStore(path.join(tmp("obs-set-"), "settings.json")),
    genAdmin: async (method, apiPath, body) => {
      calls.push([method, apiPath, body]);
      return method === "GET" ? [200, { clients: { house: "local", "hello-world": "remote" } }] : [200, { client: "house", from: "local", to: body.target }];
    },
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
  try {
    assert.equal((await call("/api/genroute", { token: "x" })).status, 401);
    // Gateway client names map back to observatory bot keys.
    assert.deepEqual((await call("/api/genroute")).json, { clients: { house: "local", helloworld: "remote" } });
    await call("/api/genroute/helloworld", { method: "PUT", body: JSON.stringify({ target: "local" }) });
    assert.deepEqual(calls.at(-1), ["PUT", "/admin/routing/hello-world", { target: "local" }]);
    const put = await call("/api/genroute/house", { method: "PUT", body: JSON.stringify({ target: "remote" }) });
    assert.equal(put.status, 200);
    assert.deepEqual(calls.at(-1), ["PUT", "/admin/routing/house", { target: "remote" }]);
    // Negative controls: bad target, foreign Origin, no Origin, POST, bad key.
    const n = calls.length;
    assert.equal((await call("/api/genroute/house", { method: "PUT", body: JSON.stringify({ target: "https://evil" }) })).status, 400);
    assert.equal((await call("/api/genroute/house", { method: "PUT", body: JSON.stringify({ target: "remote" }), origin: "http://evil.test" })).status, 403);
    assert.equal((await call("/api/genroute/house", { method: "PUT", body: JSON.stringify({ target: "remote" }), origin: null })).status, 403);
    assert.equal((await call("/api/genroute/house", { method: "POST", body: "{}" })).status, 405);
    assert.equal((await call("/api/genroute/House!", { method: "PUT", body: "{}" })).status, 405);
    assert.equal(calls.length, n);
  } finally {
    server.close();
  }
});
