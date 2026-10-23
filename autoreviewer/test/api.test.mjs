import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createApi } from "../src/api.mjs";
import { ClientMap, normalizeAddress, parseClientMap } from "../src/clientmap.mjs";
import { TelegramClient, postJson } from "../src/telegram.mjs";
import { PROPOSAL, press, setup } from "./helpers.mjs";

let s;
let server;
afterEach(async () => {
  await new Promise((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  s?.cleanup();
});

async function start(mapText) {
  s = setup();
  const mapFile = join(s.dir, "client.map");
  writeFileSync(mapFile, mapText);
  server = createApi({ ledger: s.ledger, clientMap: new ClientMap(mapFile), bot: s.bot });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}

async function call(base, method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}

describe("client map", () => {
  it("parses lines and skips comments", () => {
    const m = parseClientMap("# generated\n172.30.10.12=alpha\n\nbad line\n172.30.10.13 = beta\n");
    assert.deepEqual([...m], [["172.30.10.12", "alpha"], ["172.30.10.13", "beta"]]);
    assert.equal(normalizeAddress("::ffff:172.30.10.12"), "172.30.10.12");
  });
});

describe("HTTP interface", () => {
  it("the requester comes from the source address, not from the body", async () => {
    const base = await start("127.0.0.1=alpha\n");
    const r = await call(base, "POST", "/v1/grants", { ...PROPOSAL, requester: "gamma" });
    assert.equal(r.status, 201);
    assert.equal(r.body.grant.requester, "alpha");
    assert.equal(r.body.grant.status, "proposed");
    assert.equal(r.body.grant.card, undefined);
    assert.equal(s.telegram.calls[0].method, "sendMessage");
  });

  it("NEGATIVE CONTROL: an unmapped address is refused and no card is sent", async () => {
    const base = await start("10.0.0.9=alpha\n");
    const r = await call(base, "POST", "/v1/grants", PROPOSAL);
    assert.equal(r.status, 403);
    assert.equal(s.ledger.list().length, 0);
    assert.equal(s.telegram.calls.length, 0);
    assert.equal((await call(base, "GET", "/v1/grants")).status, 403);
    assert.equal((await call(base, "GET", "/healthz")).status, 200);
  });

  it("NEGATIVE CONTROL: a map line that names console or mike is refused (CLAW-127)", async () => {
    for (const name of ["console", "mike"]) {
      const base = await start(`127.0.0.1=${name}\n`);
      const r = await call(base, "POST", "/v1/directives", { bot: "beta", goal: "x" });
      assert.equal(r.status, 403);
      assert.equal(s.ledger.list().length, 0);
      await new Promise((res) => server.close(() => res()));
      server = undefined;
      s.cleanup();
    }
  });

  it("NEGATIVE CONTROL: no route can decide or revoke a grant", async () => {
    const base = await start("127.0.0.1=alpha\n");
    const { body } = await call(base, "POST", "/v1/grants", PROPOSAL);
    for (const [m, p] of [
      ["POST", `/v1/grants/${body.grant.id}`],
      ["PUT", `/v1/grants/${body.grant.id}`],
      ["POST", `/v1/grants/${body.grant.id}/approve`],
      ["DELETE", `/v1/grants/${body.grant.id}`],
    ]) {
      assert.equal((await call(base, m, p, { status: "active", ttl_hours: 24 })).status, 404, `${m} ${p}`);
    }
    assert.equal(s.ledger.get(body.grant.id).status, "proposed");
  });

  it("a bad proposal gets 400 with the reason", async () => {
    const base = await start("127.0.0.1=alpha\n");
    const r = await call(base, "POST", "/v1/grants", { ...PROPOSAL, ttl_hours: 72 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /ttl_hours/);
  });

  it("the long-poll returns when Mike answers", async () => {
    const base = await start("127.0.0.1=alpha\n");
    const { body } = await call(base, "POST", "/v1/grants", PROPOSAL);
    const waiting = call(base, "GET", `/v1/grants/${body.grant.id}?wait_ms=5000`);
    await new Promise((r) => setTimeout(r, 200));
    await s.bot.handleUpdate(press(s.ledger.get(body.grant.id).card.message_id, `g:${body.grant.id}:4`));
    const r = await waiting;
    assert.equal(r.body.grant.status, "active");
  });

  it("a card that cannot be sent closes the proposal and returns 502", async () => {
    const base = await start("127.0.0.1=alpha\n");
    s.telegram.sendMessage = async () => {
      throw new Error("telegram down");
    };
    const r = await call(base, "POST", "/v1/grants", PROPOSAL);
    assert.equal(r.status, 502);
    assert.equal(s.ledger.list()[0].status, "revoked");
  });
});

describe("Telegram client transport", () => {
  it("posts JSON and parses the Bot API reply", async () => {
    let seenPath;
    server = createServer((req, res) => {
      seenPath = req.url;
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { message_id: 7, echo: JSON.parse(b) } }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const tg = new TelegramClient({ token: "123:abc", apiBase: `http://127.0.0.1:${server.address().port}` });
    const result = await tg.sendMessage(42, "hello");
    assert.equal(seenPath, "/bot123:abc/sendMessage");
    assert.equal(result.echo.text, "hello");
    assert.equal(result.echo.parse_mode, undefined);
  });

  it("reports a refused proxy CONNECT as an error", async () => {
    server = createServer();
    server.on("connect", (req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    await assert.rejects(
      postJson("https://api.telegram.org/botX/getMe", {}, { proxy: `http://127.0.0.1:${server.address().port}`, timeoutMs: 3000 }),
      /CONNECT refused: HTTP 403/,
    );
  });
});
