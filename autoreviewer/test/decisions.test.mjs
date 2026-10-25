import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ObservatoryDecisions } from "../src/decisions.mjs";
import { PROPOSAL, setup } from "./helpers.mjs";

// Mike decides from the fleet observatory through a host-only folder.

let s;
afterEach(() => s?.cleanup());

function make() {
  s = setup();
  const dir = join(s.dir, "decisions");
  const gh = { calls: [], decide: (id, approve, by) => (gh.calls.push(["decide", id, approve, by]), { id, status: approve ? "approved" : "denied", repos: [] }), revoke: (id, by) => (gh.calls.push(["revoke", id, by]), { id, status: "revoked", repos: [] }) };
  s.bot.refreshGhCard = async () => {};
  s.bot.notifyGithub = () => {};
  const od = new ObservatoryDecisions(dir, { ledger: s.ledger, ghStore: gh, bot: s.bot, log: (r) => s.logs.push(r) });
  let n = 0;
  const run = async (body) => {
    const name = `${String(++n).padStart(4, "0")}.json`;
    writeFileSync(join(dir, "inbox", name), typeof body === "string" ? body : JSON.stringify(body));
    await od.tick();
    assert.equal(existsSync(join(dir, "inbox", name)), false);
    return JSON.parse(readFileSync(join(dir, "done", name), "utf8"));
  };
  return { od, dir, gh, run };
}

async function proposedGrant() {
  const { grant } = s.ledger.propose("alpha", PROPOSAL);
  await s.bot.sendGrantCard(grant);
  return grant;
}

describe("observatory decisions", () => {
  it("approves a proposed grant, edits its Telegram card, and records the observatory as the decider", async () => {
    const c = make();
    const g = await proposedGrant();
    const r = await c.run({ op: "decide", id: g.id, hours: 4 });
    assert.equal(r.ok, true);
    assert.equal(r.status, "active");
    assert.equal(s.ledger.get(g.id).decided_by, "observatory");
    assert.ok(s.telegram.calls.some((x) => x.method === "editMessageText"));
  });

  it("denies with hours null and refuses a second decision", async () => {
    const c = make();
    const g = await proposedGrant();
    assert.equal((await c.run({ op: "decide", id: g.id, hours: null })).status, "denied");
    const again = await c.run({ op: "decide", id: g.id, hours: 1 });
    assert.equal(again.ok, false);
    assert.match(again.error, /not proposed/);
  });

  it("keeps the ledger limits: a grant cannot run past 24 h", async () => {
    const c = make();
    const g = await proposedGrant();
    const r = await c.run({ op: "decide", id: g.id, hours: 48 });
    assert.equal(r.ok, false);
    assert.equal(s.ledger.get(g.id).status, "proposed");
  });

  it("proposes a directive as mike, sends the card, and approves, renews and revokes it", async () => {
    const c = make();
    const p = await c.run({ op: "directive", bot: "beta", goal: "Ship ORG-171", lane: "oasis-ai" });
    assert.equal(p.ok, true);
    assert.equal(s.ledger.get(p.id).requester, "mike");
    assert.match(s.telegram.calls.find((x) => x.method === "sendMessage").text, /STANDING DIRECTIVE/);
    assert.equal((await c.run({ op: "decide", id: p.id, hours: 168 })).status, "active");
    s.now.advance(3600 * 1000);
    const renewed = await c.run({ op: "renew", id: p.id, hours: 168 });
    assert.equal(renewed.ok, true);
    assert.equal(renewed.expires, new Date(s.now() + 168 * 3600 * 1000).toISOString());
    assert.equal((await c.run({ op: "revoke", id: p.id })).status, "revoked");
  });

  it("routes GitHub decisions to the GitHub store", async () => {
    const c = make();
    assert.equal((await c.run({ op: "gh-decide", id: "GH-0001", approve: true })).status, "approved");
    assert.equal((await c.run({ op: "gh-revoke", id: "GH-0001" })).status, "revoked");
    assert.deepEqual(c.gh.calls, [["decide", "GH-0001", true, "observatory"], ["revoke", "GH-0001", "observatory"]]);
    assert.equal((await c.run({ op: "gh-decide", id: "GH-0001", approve: "yes" })).ok, false);
  });

  it("refuses a bad id, an unknown op, junk and a symlink", async () => {
    const c = make();
    assert.match((await c.run({ op: "decide", id: "../x", hours: 1 })).error, /GRANT-NNNN/);
    assert.match((await c.run({ op: "approve-all" })).error, /unknown op/);
    assert.equal((await c.run("{not json")).ok, false);
    const target = join(s.dir, "target.json");
    writeFileSync(target, JSON.stringify({ op: "revoke", id: "GRANT-0001" }));
    symlinkSync(target, join(c.dir, "inbox", "link.json"));
    await c.od.tick();
    assert.match(JSON.parse(readFileSync(join(c.dir, "done", "link.json"), "utf8")).error, /not a regular file/);
  });
});
