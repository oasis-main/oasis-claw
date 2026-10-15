import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createApi } from "../src/api.mjs";
import { AutoreviewerBot } from "../src/bot.mjs";
import { ClientMap } from "../src/clientmap.mjs";
import { GrantLedger } from "../src/ledger.mjs";
import { Mailer } from "../src/mailer.mjs";
import { BOTS, MIKE, STRANGER, clock, fakeTelegram, press, tempDir, text } from "./helpers.mjs";

// CLAW-124: standing directives (rolling 7 days, any session of ONE bot).

let t;
let server;
afterEach(async () => {
  await new Promise((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  t?.cleanup();
});

function setup() {
  t = tempDir();
  const now = clock();
  const ledger = new GrantLedger(join(t.dir, "ledger"), { bots: BOTS, now });
  const telegram = fakeTelegram();
  const outbox = join(t.dir, "outbox");
  const bot = new AutoreviewerBot({ telegram, ledger, mailer: new Mailer({ outbox, now }), coordinator: "gamma", ownerId: MIKE, chatId: MIKE, now });
  ledger.onSweep = (c) => bot.onSwept(c);
  const mails = () => readdirSync(outbox).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(outbox, f), "utf8")));
  return { now, ledger, telegram, bot, mails };
}

const CMD = "/directive beta Ship KIN-218 then KIN-215 | may: push the kinematics repo dev | must not: merge to prod | lane: racing";

describe("/directive", () => {
  it("Mike's command opens a card; Approve 7 d makes it active for 168 h and mails the bot and the coordinator", async () => {
    const s = setup();
    await s.bot.handleUpdate(text(CMD));
    const card = s.telegram.calls.find((c) => c.method === "sendMessage");
    assert.match(card.text, /^STANDING DIRECTIVE DIR-0001 for beta \(racing\)\nProposed by: you/);
    assert.match(card.text, /Must not: merge to prod/);
    const d = s.ledger.get("DIR-0001");
    assert.equal(d.status, "proposed");
    await s.bot.handleUpdate(press(d.card.message_id, "d:DIR-0001:168"));
    assert.equal(d.status, "active");
    assert.equal(Date.parse(d.expires) - s.now(), 168 * 3600 * 1000);
    const m = s.mails();
    assert.equal(m.length, 1);
    assert.deepEqual(m[0].to, ["beta", "gamma"]);
    assert.match(m[0].body, /covers beta's own work in any session/);
    assert.equal(m[0].thread_id, "grant-DIR-0001");
  });

  it("NEGATIVE CONTROL: a stranger's press does nothing", async () => {
    const s = setup();
    await s.bot.handleUpdate(text(CMD));
    const d = s.ledger.get("DIR-0001");
    await s.bot.handleUpdate(press(d.card.message_id, "d:DIR-0001:168", STRANGER, MIKE));
    assert.equal(d.status, "proposed");
  });

  it("renew is rolling; a reminder comes once 24 h before the end; revoke mails", async () => {
    const s = setup();
    await s.bot.handleUpdate(text(CMD));
    const d = s.ledger.get("DIR-0001");
    await s.bot.handleUpdate(press(d.card.message_id, "d:DIR-0001:72"));
    s.now.advance(50 * 3600 * 1000); // 22 h left
    await s.bot.remindDirectives();
    await s.bot.remindDirectives();
    const reminders = s.telegram.calls.filter((c) => c.method === "sendMessage" && /ends/.test(c.text));
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].replyMarkup.inline_keyboard[0][0].callback_data, "dr:DIR-0001");
    await s.bot.handleUpdate(press(999, "dr:DIR-0001"));
    assert.equal(Date.parse(d.expires) - s.now(), 168 * 3600 * 1000);
    await s.bot.handleUpdate(text("/revoke DIR-0001"));
    assert.equal(d.status, "revoked");
    assert.match(s.mails().find((x) => /revoked/.test(x.subject)).body, /now needs Mike again/);
  });

  it("an expired directive mails the bot", async () => {
    const s = setup();
    await s.bot.handleUpdate(text(CMD));
    const d = s.ledger.get("DIR-0001");
    await s.bot.handleUpdate(press(d.card.message_id, "d:DIR-0001:72"));
    s.now.advance(73 * 3600 * 1000);
    s.ledger.sweep();
    await new Promise((r) => setImmediate(r));
    assert.equal(d.status, "expired");
    assert.ok(s.mails().some((x) => /expired/.test(x.subject)));
  });

  it("NEGATIVE CONTROL: more than 7 days is refused; /grants does not list directives", async () => {
    const s = setup();
    assert.throws(() => s.ledger.proposeDirective("mike", { bot: "beta", goal: "x", ttl_hours: 200 }), /at most 168/);
    await s.bot.handleUpdate(text(CMD));
    await s.bot.handleUpdate(text("/grants"));
    assert.match(s.telegram.calls.at(-1).text, /No active grants/);
  });
});

describe("POST /v1/directives", () => {
  async function start(mapText) {
    const s = setup();
    const mapFile = join(t.dir, "client.map");
    writeFileSync(mapFile, mapText);
    server = createApi({ ledger: s.ledger, clientMap: new ClientMap(mapFile), bot: s.bot, coordinators: ["gamma"] });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const post = (body) =>
      fetch(`http://127.0.0.1:${server.address().port}/v1/directives`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    return { ...s, post };
  }

  it("a bot may propose for itself; the coordinator for any bot", async () => {
    const a = await start("127.0.0.1=beta\n");
    assert.equal((await a.post({ bot: "beta", goal: "own lane" })).status, 201);
    await new Promise((r) => server.close(() => r()));
    server = undefined;
    t.cleanup();
    const b = await start("127.0.0.1=gamma\n");
    assert.equal((await b.post({ bot: "beta", goal: "lane for beta" })).status, 201);
  });

  it("NEGATIVE CONTROL: a non-coordinator cannot propose for another bot", async () => {
    const s = await start("127.0.0.1=alpha\n");
    const r = await s.post({ bot: "beta", goal: "x" });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /only for itself/);
    assert.equal(s.telegram.calls.length, 0);
  });
});
