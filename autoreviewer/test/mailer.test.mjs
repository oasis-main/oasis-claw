import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { AutoreviewerBot } from "../src/bot.mjs";
import { GithubGrantStore } from "../src/ghgrants.mjs";
import { GrantLedger, PROPOSAL_TTL_MS } from "../src/ledger.mjs";
import { Mailer } from "../src/mailer.mjs";
import { BOTS, MIKE, PROPOSAL, STRANGER, clock, fakeTelegram, press, tempDir, text } from "./helpers.mjs";

// CLAW-123: grant decisions reach the bots by mail, on a fresh thread.

let t;
afterEach(() => t?.cleanup());

function setup() {
  t = tempDir();
  const now = clock();
  const outbox = join(t.dir, "outbox");
  const ledger = new GrantLedger(join(t.dir, "ledger"), { bots: BOTS, now });
  const gh = new GithubGrantStore(join(t.dir, "gh"), { bots: BOTS, accounts: ["acct-a"], requesters: ["gamma"], now });
  const telegram = fakeTelegram();
  const bot = new AutoreviewerBot({ telegram, ledger, ghStore: gh, mailer: new Mailer({ outbox, now }), ownerId: MIKE, chatId: MIKE, now });
  ledger.onSweep = (c) => bot.onSwept(c);
  const mails = () =>
    readdirSync(outbox, { withFileTypes: true }).filter((f) => f.name.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(outbox, f.name), "utf8")));
  return { now, ledger, gh, telegram, bot, mails, outbox };
}

async function proposedGrant(s) {
  const { grant } = s.ledger.propose("alpha", { ...PROPOSAL, grantees: ["beta", "gamma"] });
  const msg = await s.bot.sendGrantCard(grant);
  return { grant, messageId: msg.message_id };
}

describe("grant notices", () => {
  it("an approved grant mails the requester and the grantees, on thread grant-<id>", async () => {
    const s = setup();
    const { messageId } = await proposedGrant(s);
    await s.bot.handleUpdate(press(messageId, "g:GRANT-0001:4"));
    const m = s.mails();
    assert.equal(m.length, 2);
    const toReq = m.find((x) => x.to.includes("alpha"));
    const toGrantees = m.find((x) => x.to.includes("beta"));
    assert.deepEqual(toGrantees.to, ["beta", "gamma"]);
    assert.equal(toReq.thread_id, "grant-GRANT-0001");
    assert.match(toReq.body, /send the work with reach_send, thread_id "t_lane2_map" and grant_id "GRANT-0001"/);
    assert.match(toGrantees.body, /Reply on that thread WITHOUT grant_id/);
    assert.match(toGrantees.body, /not an authorization by itself/);
    // The relay requires these fields (same shape as scripts/claw-mail.mjs).
    for (const k of ["id", "to", "kind", "subject", "body", "refs", "work", "thread_id", "ts"]) assert.ok(k in toReq, k);
    assert.match(toReq.id, /^m_[0-9a-f]{24}$/);
  });

  it("a denial mails only the requester", async () => {
    const s = setup();
    const { messageId } = await proposedGrant(s);
    await s.bot.handleUpdate(press(messageId, "g:GRANT-0001:deny"));
    const m = s.mails();
    assert.equal(m.length, 1);
    assert.deepEqual(m[0].to, ["alpha"]);
    assert.match(m[0].subject, /Grant denied: GRANT-0001/);
  });

  it("a revoke mails requester and grantees; a lapse mails the requester", async () => {
    const s = setup();
    const { messageId } = await proposedGrant(s);
    await s.bot.handleUpdate(press(messageId, "g:GRANT-0001:1"));
    await s.bot.handleUpdate(text("/revoke GRANT-0001"));
    const revoked = s.mails().find((x) => /revoked/.test(x.subject));
    assert.deepEqual(revoked.to, ["alpha", "beta", "gamma"]);
    const s2 = setup();
    await proposedGrant(s2);
    s2.now.advance(PROPOSAL_TTL_MS + 1);
    s2.ledger.sweep();
    await new Promise((r) => setImmediate(r));
    assert.match(s2.mails()[0].subject, /Grant lapsed/);
  });

  it("NEGATIVE CONTROL: a stranger's press sends no mail", async () => {
    const s = setup();
    const { messageId } = await proposedGrant(s);
    await s.bot.handleUpdate(press(messageId, "g:GRANT-0001:4", STRANGER, MIKE));
    assert.throws(() => s.mails(), /ENOENT/);
  });
});

describe("GitHub notices", () => {
  it("approval mails the requester and the target bot", async () => {
    const s = setup();
    const { request } = s.gh.propose("gamma", { bot: "beta", account: "acct-a", repos: ["r1"], access: "write", reason: "needs it" });
    const msg = await s.bot.sendGhCard(request);
    await s.bot.handleUpdate(press(msg.message_id, "h:GH-0001:ok"));
    const m = s.mails();
    assert.deepEqual(m.map((x) => x.to.join()).sort(), ["beta", "gamma"]);
    assert.match(m.find((x) => x.to[0] === "beta").body, /you get write on acct-a: r1/);
  });
});

describe("Mailer", () => {
  it("is off without an outbox and never throws", () => {
    assert.equal(new Mailer({ outbox: null }).send({ to: ["a"], subject: "s", body: "b", thread: "t" }), null);
    assert.equal(new Mailer({ outbox: "/proc/nope/x" }).send({ to: ["a"], subject: "s", body: "b", thread: "t" }), null);
  });
});
