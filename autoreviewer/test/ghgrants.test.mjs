import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createApi } from "../src/api.mjs";
import { AutoreviewerBot } from "../src/bot.mjs";
import { ClientMap } from "../src/clientmap.mjs";
import { GithubGrantStore } from "../src/ghgrants.mjs";
import { GrantLedger } from "../src/ledger.mjs";
import { BOTS, MIKE, STRANGER, fakeTelegram, press, tempDir, text } from "./helpers.mjs";

// CLAW-121: card-gated GitHub access requests. Only a configured requester may
// ask, only for ANOTHER bot, only named repos; only Mike's press on the
// request's own card approves; approved requests land in approved.json for the
// Mac minter. Negative controls throughout.

let t;
let server;
afterEach(async () => {
  await new Promise((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  t?.cleanup();
});

const REQ = { bot: "beta", account: "acct-a", repos: ["repo-x"], access: "write", reason: "Beta leads lane 3 and must push to dev." };

function setup() {
  t = tempDir();
  const gh = new GithubGrantStore(join(t.dir, "gh"), { bots: BOTS, accounts: ["acct-a", "acct-b"], requesters: ["gamma"] });
  const telegram = fakeTelegram();
  const ledger = new GrantLedger(join(t.dir, "ledger"), { bots: BOTS });
  const logs = [];
  const bot = new AutoreviewerBot({ telegram, ledger, ghStore: gh, ownerId: MIKE, chatId: MIKE, log: (r) => logs.push(r) });
  return { gh, telegram, bot, logs };
}

describe("GithubGrantStore.propose", () => {
  it("accepts a valid request from the configured requester", () => {
    const { gh } = setup();
    const { request } = gh.propose("gamma", REQ);
    assert.equal(request.id, "GH-0001");
    assert.equal(request.status, "proposed");
    assert.equal(request.requester, "gamma");
  });

  it("NEGATIVE CONTROL: refuses other requesters, self-requests, wildcards and unknown accounts", () => {
    const { gh } = setup();
    assert.throws(() => gh.propose("alpha", REQ), /may not request/);
    assert.throws(() => gh.propose("gamma", { ...REQ, bot: "gamma" }), /cannot request access for itself/);
    assert.throws(() => gh.propose("gamma", { ...REQ, repos: ["*"] }), /no wildcard/);
    assert.throws(() => gh.propose("gamma", { ...REQ, account: "evil" }), /account/);
    assert.throws(() => gh.propose("gamma", { ...REQ, access: "admin" }), /access/);
    assert.throws(() => gh.propose("gamma", { ...REQ, bot: "mallory" }), /unknown bot/);
    assert.equal(gh.list().length, 0);
  });

  it("returns the existing request for an identical ask", () => {
    const { gh } = setup();
    const a = gh.propose("gamma", REQ).request;
    const b = gh.propose("gamma", { ...REQ }).request;
    assert.equal(a.id, b.id);
  });
});

describe("cards", () => {
  async function proposed() {
    const s = setup();
    const { request } = s.gh.propose("gamma", REQ);
    const msg = await s.bot.sendGhCard(request);
    return { ...s, request, messageId: msg.message_id };
  }

  it("Mike's Approve writes the request to approved.json for the minter", async () => {
    const { gh, bot, telegram, request, messageId } = await proposed();
    assert.match(telegram.calls[0].text, /^GITHUB ACCESS REQUEST GH-0001\nRequested by: gamma\nFor bot: beta/);
    await bot.handleUpdate(press(messageId, "h:GH-0001:ok"));
    const onDisk = JSON.parse(readFileSync(join(gh.dir, "approved.json"), "utf8"));
    assert.equal(onDisk.requests[0].status, "approved");
    assert.equal(gh.get(request.id).decided_by, `telegram:${MIKE}`);
    assert.match(telegram.calls.find((c) => c.method === "editMessageText").text, />> APPROVED by Mike\. Minter: not applied yet/);
  });

  it("NEGATIVE CONTROL: a stranger's press or a press on another message does nothing", async () => {
    const { gh, bot, request, messageId } = await proposed();
    await bot.handleUpdate(press(messageId, "h:GH-0001:ok", STRANGER, MIKE));
    await bot.handleUpdate(press(999, "h:GH-0001:ok"));
    assert.equal(gh.get(request.id).status, "proposed");
  });

  it("Deny denies; /ghrevoke revokes an approved request", async () => {
    const s1 = await proposed();
    await s1.bot.handleUpdate(press(s1.messageId, "h:GH-0001:no"));
    assert.equal(s1.gh.get("GH-0001").status, "denied");
    t.cleanup();
    const s2 = await proposed();
    await s2.bot.handleUpdate(press(s2.messageId, "h:GH-0001:ok"));
    await s2.bot.handleUpdate(text("/ghrevoke GH-0001"));
    assert.equal(s2.gh.get("GH-0001").status, "revoked");
  });

  it("/ghgrants shows the minter's status for an approved request", async () => {
    const { gh, bot, telegram, messageId } = await proposed();
    await bot.handleUpdate(press(messageId, "h:GH-0001:ok"));
    writeFileSync(join(gh.dir, "status.json"), JSON.stringify({ "GH-0001": "applied" }));
    await bot.handleUpdate(text("/ghgrants"));
    assert.match(telegram.calls.at(-1).text, /GH-0001 \[approved\] beta write on acct-a: repo-x\n  minter: applied/);
  });
});

describe("HTTP", () => {
  async function start(mapText) {
    const s = setup();
    const mapFile = join(t.dir, "client.map");
    writeFileSync(mapFile, mapText);
    server = createApi({ ledger: new GrantLedger(join(t.dir, "l2"), { bots: BOTS }), clientMap: new ClientMap(mapFile), bot: s.bot, ghStore: s.gh });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { ...s, base: `http://127.0.0.1:${server.address().port}` };
  }
  const post = (base, body) =>
    fetch(base + "/v1/github-grants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(
      async (r) => ({ status: r.status, body: await r.json() }),
    );

  it("the requester is the mapped caller; a requester field in the body is ignored", async () => {
    const { base, telegram } = await start("127.0.0.1=gamma\n");
    const r = await post(base, { ...REQ, requester: "alpha" });
    assert.equal(r.status, 201);
    assert.equal(r.body.request.requester, "gamma");
    assert.equal(telegram.calls[0].method, "sendMessage");
  });

  it("NEGATIVE CONTROL: a mapped bot that is not a requester gets 403 and no card", async () => {
    const { base, telegram, gh } = await start("127.0.0.1=alpha\n");
    const r = await post(base, REQ);
    assert.equal(r.status, 403);
    assert.equal(telegram.calls.length, 0);
    assert.equal(gh.list().length, 0);
  });
});
