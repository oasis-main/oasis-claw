import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { GrantLedger, HISTORY_FILE, LEDGER_FILE, MAX_OPEN_PER_REQUESTER, PROPOSAL_TTL_MS } from "../src/ledger.mjs";
import { BOTS, PROPOSAL, clock, tempDir } from "./helpers.mjs";

let t;
afterEach(() => t?.cleanup());

function ledger(now = clock()) {
  t = tempDir();
  return { l: new GrantLedger(t.dir, { bots: BOTS, now }), now };
}

describe("GrantLedger.propose", () => {
  it("records a proposal on disk and in the history", () => {
    const { l } = ledger();
    const { grant, duplicate } = l.propose("alpha", PROPOSAL);
    assert.equal(duplicate, false);
    assert.equal(grant.id, "GRANT-0001");
    assert.equal(grant.status, "proposed");
    assert.equal(grant.requester, "alpha");
    assert.equal(grant.expires, null);
    const onDisk = JSON.parse(readFileSync(join(t.dir, LEDGER_FILE), "utf8"));
    assert.equal(onDisk.grants[0].id, "GRANT-0001");
    assert.match(readFileSync(join(t.dir, HISTORY_FILE), "utf8"), /"event":"proposed"/);
  });

  it("refuses an unknown requester, an unknown grantee and a self-grant", () => {
    const { l } = ledger();
    assert.throws(() => l.propose("mallory", PROPOSAL), /unknown requester/);
    assert.throws(() => l.propose("alpha", { ...PROPOSAL, grantees: ["mallory"] }), /unknown bot/);
    assert.throws(() => l.propose("alpha", { ...PROPOSAL, grantees: ["alpha"] }), /cannot grant itself/);
  });

  it("refuses a pair that the mail relay keeps apart", () => {
    t = tempDir();
    const routes = [{ from: "alpha", to: "beta" }];
    const l = new GrantLedger(t.dir, { bots: BOTS, canMail: (f, to) => routes.some((r) => r.from === f && r.to === to) });
    assert.throws(() => l.propose("delta", { ...PROPOSAL, grantees: ["epsilon"] }), /no route delta -> epsilon/);
    assert.equal(l.propose("alpha", PROPOSAL).duplicate, false);
  });

  it("refuses a TTL above 24 h, and bad limits", () => {
    const { l } = ledger();
    assert.throws(() => l.propose("alpha", { ...PROPOSAL, ttl_hours: 25 }), /ttl_hours/);
    assert.throws(() => l.propose("alpha", { ...PROPOSAL, ttl_hours: 0 }), /ttl_hours/);
    assert.throws(() => l.propose("alpha", { ...PROPOSAL, families: ["root"] }), /families/);
    assert.throws(() => l.propose("alpha", { ...PROPOSAL, path_prefixes: ["/reach/../etc"] }), /path_prefixes/);
    assert.throws(() => l.propose("alpha", { ...PROPOSAL, max_actions: 0 }), /max_actions/);
    assert.throws(() => l.propose("alpha", { ...PROPOSAL, thread_id: "a b" }), /thread_id/);
  });

  it("ignores a requester field in the body", () => {
    const { l } = ledger();
    const { grant } = l.propose("alpha", { ...PROPOSAL, requester: "gamma" });
    assert.equal(grant.requester, "alpha");
  });

  it("strips control and bidi characters from bot-written text", () => {
    const { l } = ledger();
    const { grant } = l.propose("alpha", { ...PROPOSAL, topic: "map‮ gnorw\u0007" });
    assert.equal(grant.topic, "map gnorw");
  });

  it("returns the open proposal for an identical request", () => {
    const { l } = ledger();
    const a = l.propose("alpha", PROPOSAL).grant;
    const b = l.propose("alpha", { ...PROPOSAL }).grant;
    assert.equal(a.id, b.id);
    assert.equal(l.list().length, 1);
  });

  it("limits open proposals for one requester", () => {
    const { l } = ledger();
    for (let i = 0; i < MAX_OPEN_PER_REQUESTER; i++) l.propose("alpha", { ...PROPOSAL, thread_id: `t_${i}` });
    assert.throws(() => l.propose("alpha", { ...PROPOSAL, thread_id: "t_extra" }), /open proposals/);
    // Another requester is not affected.
    assert.equal(l.propose("gamma", { ...PROPOSAL, thread_id: "t_extra" }).duplicate, false);
  });
});

describe("GrantLedger.decide / revoke / sweep", () => {
  it("activates with Mike's TTL, which can differ from the requested TTL", () => {
    const { l, now } = ledger();
    const { grant } = l.propose("alpha", PROPOSAL);
    const g = l.decide(grant.id, 1, "telegram:111");
    assert.equal(g.status, "active");
    assert.equal(Date.parse(g.expires) - now(), 3600 * 1000);
  });

  it("refuses a TTL above 24 h at decision time too", () => {
    const { l } = ledger();
    const { grant } = l.propose("alpha", PROPOSAL);
    assert.throws(() => l.decide(grant.id, 48, "x"), /at most 24/);
    assert.equal(l.get(grant.id).status, "proposed");
  });

  it("decides a grant only once", () => {
    const { l } = ledger();
    const { grant } = l.propose("alpha", PROPOSAL);
    l.decide(grant.id, null, "x");
    assert.throws(() => l.decide(grant.id, 4, "x"), /denied, not proposed/);
  });

  it("expires an active grant and lapses an unanswered proposal", () => {
    const { l, now } = ledger();
    const a = l.propose("alpha", PROPOSAL).grant;
    const b = l.propose("alpha", { ...PROPOSAL, thread_id: "t_other" }).grant;
    l.decide(a.id, 1, "x");
    now.advance(PROPOSAL_TTL_MS + 1);
    const changed = l.sweep().map((g) => `${g.id}:${g.status}`).sort();
    assert.deepEqual(changed, [`${a.id}:expired`, `${b.id}:lapsed`]);
  });

  it("revokes an active grant", () => {
    const { l } = ledger();
    const { grant } = l.propose("alpha", PROPOSAL);
    l.decide(grant.id, 4, "x");
    assert.equal(l.revoke(grant.id, "done early", "x").status, "revoked");
    assert.throws(() => l.revoke(grant.id, "", "x"), /revoked/);
  });

  it("reloads the same state from disk", () => {
    const { l, now } = ledger();
    const { grant } = l.propose("alpha", PROPOSAL);
    l.decide(grant.id, 4, "x");
    const again = new GrantLedger(t.dir, { bots: BOTS, now });
    assert.equal(again.get(grant.id).status, "active");
    assert.equal(again.nextId(), "GRANT-0002");
  });
});
