import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ConsoleProposals } from "../src/console.mjs";
import { setup } from "./helpers.mjs";

// CLAW-127: Claude Code proposes directives through a host-only folder.

let s;
afterEach(() => s?.cleanup());

function make({ failCard = false } = {}) {
  s = setup();
  if (failCard) s.telegram.sendMessage = async () => { throw new Error("telegram down"); };
  const dir = join(s.dir, "console");
  const cp = new ConsoleProposals(dir, { ledger: s.ledger, bot: s.bot, log: (r) => s.logs.push(r) });
  const drop = (name, body) => writeFileSync(join(dir, "inbox", name), typeof body === "string" ? body : JSON.stringify(body));
  const result = (name) => JSON.parse(readFileSync(join(dir, "done", name), "utf8"));
  return { cp, dir, drop, result };
}

const BODY = { bot: "beta", lane: "oasis-ai", goal: "Build ORG-171 P0", may: "push beta/* branches", must_not: "merge or deploy" };

describe("console directive proposals", () => {
  it("a proposal for any bot opens Mike's card, stays proposed, and reports the ID", async () => {
    const c = make();
    c.drop("a.json", BODY);
    await c.cp.tick();
    const r = c.result("a.json");
    assert.equal(r.ok, true);
    assert.equal(r.bot, "beta");
    assert.equal(r.status, "proposed");
    const d = s.ledger.get(r.id);
    assert.equal(d.requester, "console");
    assert.equal(d.status, "proposed");
    const card = s.telegram.calls.find((x) => x.method === "sendMessage");
    assert.match(card.text, /STANDING DIRECTIVE .* for beta/);
    assert.match(card.text, /Proposed by: console/);
    assert.equal(existsSync(join(c.dir, "inbox", "a.json")), false);
  });

  it("an invalid body is refused, recorded in done/, and removed", async () => {
    const c = make();
    c.drop("bad.json", { bot: "nobody", goal: "x" });
    c.drop("junk.json", "{not json");
    await c.cp.tick();
    assert.equal(c.result("bad.json").ok, false);
    assert.match(c.result("bad.json").error, /unknown bot/);
    assert.equal(c.result("junk.json").ok, false);
    assert.equal(s.ledger.list({}).length, 0);
  });

  it("a symlink is refused and never followed", async () => {
    const c = make();
    const target = join(s.dir, "target.json");
    writeFileSync(target, JSON.stringify(BODY));
    symlinkSync(target, join(c.dir, "inbox", "link.json"));
    await c.cp.tick();
    assert.match(c.result("link.json").error, /not a regular file/);
    assert.equal(s.ledger.list({}).length, 0);
    assert.equal(existsSync(target), true);
  });

  it("ignores .tmp files, so a half-written proposal is never read", async () => {
    const c = make();
    c.drop("w.json.tmp", BODY);
    await c.cp.tick();
    assert.equal(s.ledger.list({}).length, 0);
    assert.equal(existsSync(join(c.dir, "inbox", "w.json.tmp")), true);
  });

  it("no card means the proposal is closed at once", async () => {
    const c = make({ failCard: true });
    c.drop("a.json", BODY);
    await c.cp.tick();
    const r = c.result("a.json");
    assert.equal(r.ok, false);
    assert.equal(s.ledger.get(r.id).status, "revoked");
  });

  it("a bot still may not propose for another bot", () => {
    s = setup();
    assert.throws(() => s.ledger.proposeDirective("alpha", BODY), /only for itself/);
  });
});
