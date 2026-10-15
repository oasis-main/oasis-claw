import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { DigestScheduler, digestMessage, needsText, nyParts, openText, registerDigestCommands } from "../src/digest.mjs";
import { GrantLedger } from "../src/ledger.mjs";
import { BOTS, clock, press, setup, tempDir, text } from "./helpers.mjs";

// CLAW-124: the weekday 08:00 New York digest, /open, /needs, /brief.

let t;
afterEach(() => t?.cleanup());

// Thursday 2026-10-15, 08:00 New York (EDT, UTC-4).
const THU_0800 = Date.parse("2026-10-15T12:00:00Z");

function snap(now) {
  return {
    generated_at: new Date(now - 60_000).toISOString(),
    today: "2026-10-15",
    bots: {
      alpha: {
        status: "running", health: "healthy",
        reviewer: { verdicts24h: { allow: 9, deny: 2 } },
        morning: [{ key: "fleet-morning-work", last_at: "2026-10-15T11:00:00Z", last_status: "ok", last_minutes: 31, errors: 0 }],
        status_file: {
          updated_today: true, filled: true,
          parsed: {
            status: "KIN-218 half done", needs: ["Approve the prod merge for KIN-218"],
            open: [
              { item: "KIN-218", next: "finish the parser", directive: "DIR-0001", since: "2026-10-13", stale: false },
              { item: "KIN-215", next: "wait for data", directive: null, since: "2026-10-12", stale: true },
            ],
          },
        },
      },
      beta: {
        status: "running", health: "healthy", reviewer: { verdicts24h: { allow: 3 } },
        morning: [{ key: "fleet-morning-work", last_at: null, next_at: "2026-10-16T11:10:00Z" }],
        status_file: { updated_today: false, filled: true, parsed: { status: "idle", needs: [], open: [] } },
      },
      gamma: { status: "running", health: "healthy", health_only: true },
    },
    brief: { date: "2026-10-15", updated_at: "2026-10-15T11:50:00Z", text: "What happened: alpha moved KIN-218." },
    mail: {}, ledgers: {},
  };
}

function fixture(now = clock(THU_0800)) {
  t = tempDir();
  const ledger = new GrantLedger(join(t.dir, "ledger"), { bots: BOTS, now });
  const snapPath = join(t.dir, "snapshot.json");
  writeFileSync(snapPath, JSON.stringify(snap(now())));
  const sent = [];
  const scheduler = new DigestScheduler({ stateFile: join(t.dir, "state", "digest.json"), snapshotPath: snapPath, ledger, send: async (text, markup) => sent.push({ text, markup }), now });
  return { now, ledger, snapPath, sent, scheduler };
}

function activeDirective(ledger, bot = "alpha", hours = 168) {
  const d = ledger.proposeDirective("mike", { bot, goal: "Ship KIN-218", may: "push dev", must_not: "merge to prod", lane: "racing" });
  return ledger.decide(d.id, hours, "test");
}

describe("nyParts", () => {
  it("uses New York time across the UTC date line", () => {
    assert.deepEqual(nyParts(Date.parse("2026-10-16T02:30:00Z")), { date: "2026-10-15", hour: 22, minute: 30, weekday: "Thu" });
  });
});

describe("digestMessage", () => {
  it("shows directives, lanes, silent bots, needs, refusals and the brief note; health-only bots are left out", () => {
    const f = fixture();
    activeDirective(f.ledger);
    const m = digestMessage(snap(f.now()), f.ledger, f.now());
    assert.match(m.text, /^MORNING DIGEST 2026-10-15 \(New York 08:00\)/);
    assert.match(m.text, /DIR-0001 alpha \(racing\): 7 d left/);
    assert.match(m.text, /- no directive: beta/);
    assert.match(m.text, /alpha: morning ok at 07:00 \(31 min\) \| 2 open, 1 STALE \| 1 needs/);
    assert.match(m.text, /top: KIN-218 -> finish the parser/);
    assert.match(m.text, /beta: morning job not run yet/);
    assert.match(m.text, /SILENT \(no STATUS.md update today\): beta/);
    assert.match(m.text, /- alpha: Approve the prod merge for KIN-218/);
    assert.match(m.text, /REFUSALS AND CARDS, last 24 h: alpha 2/);
    assert.match(m.text, /BRIEF: the coordinator wrote BRIEF-2026-10-15.md at 07:50/);
    assert.doesNotMatch(m.text, /gamma/);
    assert.equal(m.stale, 1);
    const buttons = m.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.deepEqual(buttons, ["w:beta", "w:alpha"]);
  });

  it("offers Renew only for a directive that ends within 48 h", () => {
    const f = fixture();
    activeDirective(f.ledger, "alpha", 24);
    const m = digestMessage(snap(f.now()), f.ledger, f.now());
    assert.match(m.text, /24 h left \(renew\)/);
    assert.equal(m.replyMarkup.inline_keyboard[0][0].callback_data, "dr:DIR-0001");
  });

  it("NEGATIVE CONTROL: with no directive it says the sessions only read; with no brief it says so", () => {
    const f = fixture();
    const s = snap(f.now());
    s.brief = { date: "2026-10-14", updated_at: "2026-10-14T11:50:00Z", text: "old" };
    const m = digestMessage(s, f.ledger, f.now());
    assert.match(m.text, /none active\. Morning sessions only read/);
    assert.match(m.text, /BRIEF: no BRIEF-2026-10-15.md from the coordinator today \(no brief job is set up\)/);
  });
});

describe("DigestScheduler", () => {
  it("sends once on a weekday at 08:00, then the brief as a second message; not again that day", async () => {
    const f = fixture(clock(THU_0800 - 60_000));
    assert.equal(await f.scheduler.tick(), false, "07:59 is too early");
    f.now.advance(60_000);
    assert.equal(await f.scheduler.tick(), true);
    assert.equal(f.sent.length, 2);
    assert.match(f.sent[1].text, /^BRIEF-2026-10-15.md \(written by the coordinator bot\):\n\nWhat happened/);
    f.now.advance(30 * 60_000);
    assert.equal(await f.scheduler.tick(), false);
    assert.equal(f.sent.length, 2);
  });

  it("remembers the day across a restart", async () => {
    const f = fixture();
    await f.scheduler.tick();
    const again = new DigestScheduler({ stateFile: f.scheduler.stateFile, snapshotPath: f.snapPath, ledger: f.ledger, send: async () => assert.fail("sent twice"), now: f.now });
    assert.equal(await again.tick(), false);
  });

  it("NEGATIVE CONTROL: no digest on a weekend or after 11:00", async () => {
    const sat = fixture(clock(Date.parse("2026-10-17T12:00:00Z")));
    assert.equal(await sat.scheduler.tick(), false);
    t.cleanup();
    const late = fixture(clock(Date.parse("2026-10-15T15:00:00Z")));
    assert.equal(await late.scheduler.tick(), false);
    assert.equal(late.sent.length, 0);
  });

  it("no snapshot: one short message, and no throw", async () => {
    const f = fixture();
    const s = new DigestScheduler({ stateFile: join(t.dir, "d.json"), snapshotPath: join(t.dir, "missing.json"), ledger: f.ledger, send: async (x) => f.sent.push({ text: x }), now: f.now });
    assert.equal(await s.tick(), true);
    assert.match(f.sent[0].text, /^MORNING DIGEST: No fleet snapshot yet/);
    assert.ok(existsSync(join(t.dir, "d.json")));
  });
});

describe("/open, /needs", () => {
  it("lists open items with STALE and the directive, and every NEEDS line", () => {
    const s = snap(THU_0800);
    const o = openText(s, null);
    assert.match(o, /alpha \(STATUS.md updated today\):\n- KIN-218 -> finish the parser \[DIR-0001\] \(since 2026-10-13\)\n- STALE KIN-215 -> wait for data/);
    assert.match(o, /beta \(STATUS.md NOT updated today\):\n- no OPEN list yet/);
    assert.match(openText(s, "beta"), /^OPEN WORK \(beta\)/);
    assert.equal(openText(s, "nobody"), 'No lane bot "nobody".');
    assert.match(needsText(s), /- alpha: Approve the prod merge for KIN-218/);
  });
});

describe("bot wiring", () => {
  it("/brief sends the digest; the Watch button calls the registered handler, only for Mike", async () => {
    const s = setup();
    t = { cleanup: s.cleanup };
    const snapPath = join(s.dir, "snapshot.json");
    writeFileSync(snapPath, JSON.stringify(snap(s.now())));
    const scheduler = new DigestScheduler({ stateFile: join(s.dir, "digest.json"), snapshotPath: snapPath, ledger: s.ledger, send: (x, m) => s.telegram.sendMessage(111, x, m), now: s.now });
    registerDigestCommands(s.bot.commands, scheduler, snapPath, s.now);
    const watched = [];
    s.bot.callbackHandlers.set("watch", (p) => (watched.push(p.bot), `Watching ${p.bot}`));
    await s.bot.handleUpdate(text("/brief"));
    assert.ok(s.telegram.calls.some((c) => c.method === "sendMessage" && /^MORNING DIGEST/.test(c.text)));
    await s.bot.handleUpdate(press(1, "w:beta", 999, 111));
    assert.deepEqual(watched, [], "a stranger's press does nothing");
    await s.bot.handleUpdate(press(1, "w:beta"));
    assert.deepEqual(watched, ["beta"]);
    assert.equal(s.telegram.calls.at(-1).text, "Watching beta");
  });
});
