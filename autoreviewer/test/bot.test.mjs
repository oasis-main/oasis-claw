import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PROPOSAL_TTL_MS } from "../src/ledger.mjs";
import { MIKE, PROPOSAL, STRANGER, press, setup, text } from "./helpers.mjs";

let s;
afterEach(() => s?.cleanup());

async function proposeWithCard() {
  s = setup();
  const { grant } = s.ledger.propose("alpha", PROPOSAL);
  const msg = await s.bot.sendGrantCard(grant);
  return { grant, messageId: msg.message_id };
}

describe("grant card", () => {
  it("is plain text with the fixed fields and the bot text under a named label", async () => {
    const { grant } = await proposeWithCard();
    const card = s.telegram.calls[0];
    assert.equal(card.method, "sendMessage");
    assert.match(card.text, /^FLEET GRANT REQUEST GRANT-0001\nFrom: alpha\nTo: beta\nThread: t_lane2_map/);
    assert.match(card.text, /Intent \(written by alpha\):\nBeta may run/);
    const buttons = card.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.deepEqual(buttons, ["g:GRANT-0001:1", "g:GRANT-0001:4", "g:GRANT-0001:24", "g:GRANT-0001:deny"]);
    assert.equal(s.ledger.get(grant.id).card.message_id, 100);
  });
});

describe("button presses", () => {
  it("Mike's press on the card activates the grant and closes the card", async () => {
    const { grant, messageId } = await proposeWithCard();
    await s.bot.handleUpdate(press(messageId, "g:GRANT-0001:4"));
    assert.equal(s.ledger.get(grant.id).status, "active");
    assert.equal(s.ledger.get(grant.id).decided_by, `telegram:${MIKE}`);
    const edit = s.telegram.calls.find((c) => c.method === "editMessageText");
    assert.match(edit.text, />> GRANTED by Mike until /);
    assert.deepEqual(edit.replyMarkup, undefined);
  });

  it("Deny denies", async () => {
    const { grant, messageId } = await proposeWithCard();
    await s.bot.handleUpdate(press(messageId, "g:GRANT-0001:deny"));
    assert.equal(s.ledger.get(grant.id).status, "denied");
  });

  it("NEGATIVE CONTROL: a press from anyone but Mike changes nothing", async () => {
    const { grant, messageId } = await proposeWithCard();
    await s.bot.handleUpdate(press(messageId, "g:GRANT-0001:24", STRANGER, MIKE));
    await s.bot.handleUpdate(press(messageId, "g:GRANT-0001:24", MIKE, STRANGER));
    assert.equal(s.ledger.get(grant.id).status, "proposed");
    assert.equal(s.logs.filter((l) => l.event === "dropped_callback").length, 2);
    assert.equal(s.telegram.calls.filter((c) => c.method === "answerCallbackQuery").length, 0);
  });

  it("NEGATIVE CONTROL: a button on a different message cannot decide the grant", async () => {
    const { grant } = await proposeWithCard();
    await s.bot.handleUpdate(press(555, "g:GRANT-0001:24"));
    assert.equal(s.ledger.get(grant.id).status, "proposed");
    assert.match(s.telegram.calls.at(-1).text, /not on the card/);
  });

  it("a second press after the decision does not change it", async () => {
    const { grant, messageId } = await proposeWithCard();
    await s.bot.handleUpdate(press(messageId, "g:GRANT-0001:1"));
    await s.bot.handleUpdate(press(messageId, "g:GRANT-0001:24"));
    const g = s.ledger.get(grant.id);
    assert.equal(g.status, "active");
    assert.equal(Date.parse(g.expires) - Date.parse(g.approved_at), 3600 * 1000);
  });

  it("a lapsed proposal has its card closed and can no longer be granted", async () => {
    const { grant, messageId } = await proposeWithCard();
    s.now.advance(PROPOSAL_TTL_MS + 1);
    s.ledger.sweep();
    await new Promise((r) => setImmediate(r));
    assert.match(s.telegram.calls.find((c) => c.method === "editMessageText").text, /LAPSED/);
    await s.bot.handleUpdate(press(messageId, "g:GRANT-0001:4"));
    assert.equal(s.ledger.get(grant.id).status, "lapsed");
  });
});

describe("slash commands", () => {
  it("/grants lists live grants with Revoke buttons; the button revokes", async () => {
    const { grant, messageId } = await proposeWithCard();
    await s.bot.handleUpdate(press(messageId, "g:GRANT-0001:4"));
    await s.bot.handleUpdate(text("/grants"));
    const list = s.telegram.calls.filter((c) => c.method === "sendMessage").at(-1);
    assert.match(list.text, /^GRANT-0001 \[active\] alpha -> beta/);
    assert.equal(list.replyMarkup.inline_keyboard[0][0].callback_data, "r:GRANT-0001");
    await s.bot.handleUpdate(press(list.message_id ?? 999, "r:GRANT-0001"));
    assert.equal(s.ledger.get(grant.id).status, "revoked");
  });

  it("/revoke revokes and closes the card", async () => {
    const { grant, messageId } = await proposeWithCard();
    await s.bot.handleUpdate(press(messageId, "g:GRANT-0001:4"));
    await s.bot.handleUpdate(text("/revoke GRANT-0001 work finished"));
    assert.equal(s.ledger.get(grant.id).status, "revoked");
    assert.equal(s.ledger.get(grant.id).revoke_reason, "work finished");
    assert.match(s.telegram.calls.at(-1).text, /GRANT-0001 revoked/);
  });

  it("/help and /status answer; an unknown command says so", async () => {
    s = setup();
    await s.bot.handleUpdate(text("/help"));
    assert.match(s.telegram.calls.at(-1).text, /fleet-wide intents only/);
    await s.bot.handleUpdate(text("/status"));
    assert.match(s.telegram.calls.at(-1).text, /^Up \d+ min/);
    await s.bot.handleUpdate(text("/selfdestruct"));
    assert.match(s.telegram.calls.at(-1).text, /Unknown command/);
  });

  it("a new command registers without other changes", async () => {
    s = setup();
    s.bot.commands.register({ name: "fleet", description: "Fleet health", run: () => "7 bots up" });
    await s.bot.handleUpdate(text("/fleet"));
    assert.equal(s.telegram.calls.at(-1).text, "7 bots up");
    assert.ok(s.bot.commands.menu().some((c) => c.command === "fleet"));
  });

  it("NEGATIVE CONTROL: a command from anyone but Mike is dropped", async () => {
    const { grant, messageId } = await proposeWithCard();
    await s.bot.handleUpdate(press(messageId, "g:GRANT-0001:4"));
    const before = s.telegram.calls.length;
    await s.bot.handleUpdate(text("/revoke GRANT-0001", STRANGER, STRANGER));
    assert.equal(s.ledger.get(grant.id).status, "active");
    assert.equal(s.telegram.calls.length, before);
  });
});
