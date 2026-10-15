import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRouteArg, renderRouteStatus, resolveApiKey, routeRequest } from "./genroute.ts";

test("parseRouteArg maps aliases and rejects unknown targets", () => {
  assert.equal(parseRouteArg(""), "status");
  assert.equal(parseRouteArg("status"), "status");
  assert.equal(parseRouteArg("Cloud"), "remote");
  assert.equal(parseRouteArg("hetzner"), "remote");
  assert.equal(parseRouteArg("local"), "local");
  assert.equal(parseRouteArg("mac"), "local");
  assert.equal(parseRouteArg("http://evil.example"), null);
});

test("resolveApiKey reads a string or an env SecretRef, nothing else", () => {
  assert.equal(resolveApiKey("plain"), "plain");
  assert.equal(resolveApiKey({ source: "env", provider: "default", id: "TOK" }, { TOK: "abc" }), "abc");
  assert.equal(resolveApiKey({ source: "file", provider: "x", id: "/etc/passwd" }, {}), "");
  assert.equal(resolveApiKey(undefined), "");
});

test("routeRequest PUTs only the target to /routing/self with the bot token", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ client: "house", from: "local", to: "remote" }), { status: 200 });
  }) as unknown as typeof fetch;
  const res = await routeRequest("http://oasis-generation:8800/v1/", "tok", "PUT", "remote", fake);
  assert.equal(res.ok, true);
  assert.equal(calls[0].url, "http://oasis-generation:8800/v1/routing/self");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.body, JSON.stringify({ target: "remote" }));
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer tok");
});

test("routeRequest surfaces the gateway's refusal detail", async () => {
  const fake = (async () =>
    new Response(JSON.stringify({ detail: "no remote gateway is configured on this gateway" }), { status: 409 })
  ) as unknown as typeof fetch;
  const res = await routeRequest("http://g/v1", "tok", "PUT", "remote", fake);
  assert.deepEqual(res, { ok: false, error: "no remote gateway is configured on this gateway" });
});

test("routeRequest reports an unreachable gateway without throwing", async () => {
  const fake = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  const res = await routeRequest("http://g/v1", "tok", "GET", undefined, fake);
  assert.equal(res.ok, false);
});

test("renderRouteStatus names the target and the switch rule", () => {
  const text = renderRouteStatus({
    client: "house", target: "remote", targets: ["local", "remote"], remote_configured: true, may_switch: false,
  });
  assert.match(text, /house: cloud \(Hetzner VM gateway\)/);
  assert.match(text, /may not switch itself/);
});
