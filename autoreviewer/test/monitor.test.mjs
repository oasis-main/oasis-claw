import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { CommandRegistry } from "../src/bot.mjs";
import { botText, denialsText, fleetText, loadSnapshot, mailText, registerMonitorCommands } from "../src/monitor.mjs";
import { tempDir } from "./helpers.mjs";

// CLAW-122: monitoring commands over the Mac's sanitized fleet snapshot.

let t;
afterEach(() => t?.cleanup());
const NOW = Date.parse("2026-10-14T22:00:00Z");

const SNAP = {
  generated_at: "2026-10-14T21:58:00Z",
  bots: {
    alpha: {
      status: "running", health: "healthy", started_at: "2026-10-14T21:00:00Z", image: "abc",
      reviewer: { calls24h: 10, verdicts24h: { allow: 8, deny: 2 }, cards24h: { "allow-once": 1 }, grantAllows24h: 1, emptyL2_24h: 0, failClosed24h: 0,
        lastTs: "2026-10-14T21:55:00Z", lastTool: "exec", sessions1h: { telegram: 3 },
        recent: [{ ts: "2026-10-14T21:50:00Z", verdict: "deny", tool: "exec", principle: "l2:X", unattended: false, reason: "too broad" }] },
      status_file: { filled: true, updated_at: "2026-10-14T21:00:00Z", text: "STATUS: on track" },
    },
    beta: { status: "running", health: "healthy", started_at: "2026-10-14T20:00:00Z", image: "def", health_only: true },
  },
  mail: { sent24h: { alpha: 2 }, received24h: { alpha: 1 }, refusals24h: [], hop_budget: 50,
    threads: [{ thread: "t1", hops: 3, last_from: "alpha", last_at: "2026-10-14T21:30:00Z", budget_exceeded: false }] },
  ledgers: { infra: [{ id: "INFRA-0001", status: "active", title: "dev apply", requesters: ["alpha"], expires: "2026-12-31" }] },
};

describe("monitor texts", () => {
  it("/fleet: one line per bot; a health-only bot shows no activity", () => {
    const out = fleetText(SNAP, NOW);
    assert.match(out, /alpha: healthy \| last tool 5m ago \(exec\) \| 24h 8 allow, 0 escalate, 2 deny \| status 60m ago/);
    assert.match(out, /beta: healthy \(health only\)/);
  });

  it("/bot: details, status file and latest refusals", () => {
    const out = botText(SNAP, "alpha", NOW);
    assert.match(out, /cards allow-once 1; grant allows 1/);
    assert.match(out, /STATUS FILE \(60m ago\):\nSTATUS: on track/);
    assert.match(out, /21:50 deny exec \[l2:X\] too broad/);
  });

  it("NEGATIVE CONTROL: /bot on a health-only bot reveals nothing else", () => {
    const out = botText(SNAP, "beta", NOW);
    assert.match(out, /Health only/);
    assert.doesNotMatch(out, /Last tool|STATUS FILE|refusals/);
  });

  it("/denials and /mail", () => {
    assert.match(denialsText(SNAP), /alpha deny exec \[l2:X\]/);
    assert.match(denialsText(SNAP, "beta"), /No refusals for beta/);
    assert.match(mailText(SNAP, NOW), /hop budget 50[\s\S]*t1: 3 hops, last alpha 30m ago/);
  });

  it("a stale snapshot carries a warning; a missing one says so", () => {
    t = tempDir();
    const p = join(t.dir, "snapshot.json");
    writeFileSync(p, JSON.stringify({ ...SNAP, generated_at: "2026-10-14T21:30:00Z" }));
    assert.match(loadSnapshot(p, NOW).note, /WARNING: snapshot is 30 min old/);
    assert.match(loadSnapshot(join(t.dir, "nope.json"), NOW).note, /No fleet snapshot yet/);
  });

  it("the commands register and answer", () => {
    t = tempDir();
    const p = join(t.dir, "snapshot.json");
    writeFileSync(p, JSON.stringify(SNAP));
    const reg = new CommandRegistry();
    registerMonitorCommands(reg, p, () => NOW);
    assert.deepEqual(reg.menu().map((c) => c.command), ["fleet", "bot", "denials", "mail", "ledger"]);
    assert.match(reg.get("ledger").run(""), /INFRA-0001 \[active\] dev apply/);
    assert.equal(reg.get("bot").run(""), "Usage: /bot <name>");
  });
});
