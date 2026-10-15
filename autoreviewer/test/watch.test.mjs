import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { CommandRegistry } from "../src/bot.mjs";
import { Watcher, registerWatchCommands } from "../src/watch.mjs";
import { clock, tempDir } from "./helpers.mjs";

// CLAW-122 slice 3: /watch alerts from the fleet snapshot.

let t;
afterEach(() => t?.cleanup());

const OLD = { ts: "2026-10-15T11:50:00.000Z", verdict: "deny", tool: "exec", principle: "l2:OLD", unattended: false, reason: "old" };

function snap(at, { recent = [OLD], timeout = 0, health = "healthy", status = "running" } = {}) {
  return {
    generated_at: at,
    bots: {
      alpha: { status, health, reviewer: { recent, cards24h: timeout ? { timeout } : {} } },
      beta: { status: "running", health, health_only: true },
    },
    mail: {}, ledgers: {},
  };
}

function setup() {
  t = tempDir();
  const now = clock(Date.parse("2026-10-15T12:00:00Z"));
  const snapPath = join(t.dir, "snapshot.json");
  const write = (s) => writeFileSync(snapPath, JSON.stringify(s));
  write(snap("2026-10-15T11:59:00Z"));
  const sent = [];
  const mk = () => new Watcher({ stateFile: join(t.dir, "state", "watches.json"), snapshotPath: snapPath, notify: async (x) => sent.push(x), now });
  return { now, write, sent, w: mk(), mk };
}

const NEW_DENY = { ts: "2026-10-15T12:03:00.000Z", verdict: "deny", tool: "exec", principle: "l2:CREDENTIALS", unattended: false, reason: "prints a token" };
const NEW_ESC = { ts: "2026-10-15T12:04:00.000Z", verdict: "escalate", tool: "exec", principle: "hard:operator-consent-action", unattended: false, reason: "gh pr merge" };

describe("Watcher", () => {
  it("NEGATIVE CONTROL: events from before the watch do not alert", async () => {
    const { w, write, sent } = setup();
    w.add("alpha", 4);
    write(snap("2026-10-15T12:01:00Z"));
    assert.deepEqual(await w.tick(), []);
    assert.equal(sent.length, 0);
  });

  it("a new refusal and a new escalation alert once, in time order", async () => {
    const { w, write, now } = setup();
    w.add("alpha", 4);
    now.advance(300_000);
    write(snap("2026-10-15T12:05:00Z", { recent: [NEW_ESC, NEW_DENY, OLD] }));
    const out = await w.tick();
    assert.equal(out.length, 1);
    assert.match(out[0], /^WATCH alpha:\n- 12:03 deny exec \[l2:CREDENTIALS\] prints a token\n- 12:04 escalate -> card in its chat exec/);
    // NEGATIVE CONTROL: the same snapshot, and a later one with no new rows, stay quiet.
    assert.deepEqual(await w.tick(), []);
    write(snap("2026-10-15T12:07:00Z", { recent: [NEW_ESC, NEW_DENY, OLD] }));
    assert.deepEqual(await w.tick(), []);
  });

  it("card timeouts and health changes alert", async () => {
    const { w, write } = setup();
    w.add("alpha", 4);
    write(snap("2026-10-15T12:02:00Z", { timeout: 2, health: "unhealthy" }));
    const [msg] = await w.tick();
    assert.match(msg, /health: healthy -> unhealthy/);
    assert.match(msg, /card timeouts: \+2 \(last 24 h: 2\)/);
  });

  it("NEGATIVE CONTROL: a health-only bot alerts on health, never on activity", async () => {
    const { w, write } = setup();
    w.add("beta", 4);
    write(snap("2026-10-15T12:02:00Z"));
    assert.deepEqual(await w.tick(), []);
    const s = snap("2026-10-15T12:04:00Z");
    s.bots.beta.status = "exited";
    write(s);
    const [msg] = await w.tick();
    assert.equal(msg, "WATCH beta:\n- health: healthy -> exited");
  });

  it("a watch ends when its time runs out, and the list survives a restart", async () => {
    const { w, now, mk } = setup();
    w.add("alpha", 1);
    assert.deepEqual(mk().list().map((x) => x.bot), ["alpha"]);
    now.advance(3600_001);
    const out = await w.tick();
    assert.match(out[0], /WATCH alpha: ended/);
    assert.deepEqual(w.list(), []);
  });

  it("refuses an unknown bot and a watch longer than 72 h", () => {
    const { w } = setup();
    assert.throws(() => w.add("mallory", 4, ["alpha", "beta"]), /no bot "mallory"/);
    assert.throws(() => w.add("alpha", 100), /at most 72/);
  });
});

describe("/watch and /unwatch", () => {
  it("start, list and stop", () => {
    const { w } = setup();
    const reg = new CommandRegistry();
    registerWatchCommands(reg, w, ["alpha", "beta"]);
    assert.match(reg.get("watch").run("alpha 2"), /^Watching alpha until 2026-10-15 14:00 UTC/);
    assert.match(reg.get("watch").run(""), /Watching:\n- alpha until 2026-10-15 14:00 UTC/);
    assert.equal(reg.get("unwatch").run("alpha"), "Stopped watching alpha.");
    assert.equal(reg.get("unwatch").run("alpha"), "No watch on alpha.");
    assert.match(reg.get("watch").run(""), /No watches/);
  });
});
