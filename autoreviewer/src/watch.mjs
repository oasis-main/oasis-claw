// /watch alerts (CLAW-122 slice 3). Mike: "a /watch <bot> command that messages
// you when that bot gets a refusal or a card times out."
//
// Source: the same sanitized fleet snapshot as /fleet (written every 2 minutes
// on the Mac), so an alert lands within about 3 minutes and needs no new access.
// For each watched bot, one message per check covers:
//   - each NEW reviewer refusal or escalation (deny/escalate; an attended
//     escalation is a card in that bot's own chat),
//   - NEW card timeouts (approval_resolution "timeout"),
//   - a health change.
// A new watch starts from the current state: old events never alert.
// Watches are saved in the bot's state folder, so they survive a restart.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadSnapshot } from "./monitor.mjs";

export const DEFAULT_HOURS = 8;
export const MAX_HOURS = 72;
const MAX_LINES = 8;

function healthOf(b) {
  if (!b) return "missing";
  return b.status !== "running" ? b.status : (b.health ?? "running");
}

export class Watcher {
  /**
   * @param {object} o
   * @param {string} o.stateFile
   * @param {string} o.snapshotPath
   * @param {(text: string) => Promise<unknown>} o.notify
   * @param {() => number} [o.now]
   */
  constructor({ stateFile, snapshotPath, notify, now = Date.now }) {
    this.stateFile = stateFile;
    this.snapshotPath = snapshotPath;
    this.notify = notify;
    this.now = now;
    this.lastSnapshotAt = null;
    this.state = { watches: {} };
    try {
      if (stateFile && existsSync(stateFile)) this.state = JSON.parse(readFileSync(stateFile, "utf8"));
    } catch {
      this.state = { watches: {} };
    }
  }

  save() {
    if (!this.stateFile) return;
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n");
    renameSync(tmp, this.stateFile);
  }

  /** Baseline = what the snapshot shows now, so only later events alert. */
  baseline(bot) {
    const { snap } = loadSnapshot(this.snapshotPath, this.now());
    const b = snap?.bots?.[bot];
    const recent = b?.reviewer?.recent ?? [];
    return {
      seenTs: recent.reduce((m, r) => (r.ts > m ? r.ts : m), new Date(this.now()).toISOString()),
      timeouts: b?.reviewer?.cards24h?.timeout ?? 0,
      health: healthOf(b),
    };
  }

  add(bot, hours, knownBots) {
    if (knownBots && !knownBots.includes(bot)) throw new Error(`no bot "${bot}". Bots: ${knownBots.join(", ")}`);
    const h = hours === undefined ? DEFAULT_HOURS : Number(hours);
    if (!(h > 0 && h <= MAX_HOURS)) throw new Error(`hours: more than 0, at most ${MAX_HOURS}`);
    const until = new Date(this.now() + h * 3600_000).toISOString();
    this.state.watches[bot] = { until, ...this.baseline(bot) };
    this.save();
    return until;
  }

  remove(bot) {
    if (bot === "all") {
      const n = Object.keys(this.state.watches).length;
      this.state.watches = {};
      this.save();
      return n;
    }
    const had = bot in this.state.watches;
    delete this.state.watches[bot];
    this.save();
    return had ? 1 : 0;
  }

  list() {
    return Object.entries(this.state.watches).map(([bot, w]) => ({ bot, until: w.until }));
  }

  /** One check. Returns the messages sent (for tests and logs). */
  async tick() {
    const now = this.now();
    const sent = [];
    let changed = false;
    for (const [bot, w] of Object.entries(this.state.watches)) {
      if (Date.parse(w.until) <= now) {
        delete this.state.watches[bot];
        changed = true;
        const text = `WATCH ${bot}: ended (its time ran out). /watch ${bot} to watch again.`;
        await this.notify(text);
        sent.push(text);
      }
    }
    if (!Object.keys(this.state.watches).length) {
      if (changed) this.save();
      return sent;
    }
    const { snap } = loadSnapshot(this.snapshotPath, now);
    if (!snap || snap.generated_at === this.lastSnapshotAt) {
      if (changed) this.save();
      return sent;
    }
    this.lastSnapshotAt = snap.generated_at;

    for (const [bot, w] of Object.entries(this.state.watches)) {
      const b = snap.bots?.[bot];
      const lines = [];
      const health = healthOf(b);
      if (health !== w.health) {
        lines.push(`health: ${w.health} -> ${health}`);
        w.health = health;
      }
      if (b && !b.health_only) {
        const fresh = (b.reviewer?.recent ?? []).filter((r) => r.ts > w.seenTs).sort((x, y) => (x.ts < y.ts ? -1 : 1));
        for (const r of fresh.slice(0, MAX_LINES)) {
          const what = r.verdict === "escalate" ? (r.unattended ? "escalate (unattended)" : "escalate -> card in its chat") : r.verdict;
          lines.push(`${r.ts.slice(11, 16)} ${what} ${r.tool} [${r.principle}] ${r.reason}`);
        }
        if (fresh.length > MAX_LINES) lines.push(`… and ${fresh.length - MAX_LINES} more (/denials ${bot})`);
        if (fresh.length) w.seenTs = fresh[fresh.length - 1].ts;
        const timeouts = b.reviewer?.cards24h?.timeout ?? 0;
        if (timeouts > w.timeouts) lines.push(`card timeouts: +${timeouts - w.timeouts} (last 24 h: ${timeouts})`);
        w.timeouts = timeouts;
      }
      if (lines.length) {
        changed = true;
        const text = `WATCH ${bot}:\n${lines.map((l) => `- ${l}`).join("\n")}`;
        await this.notify(text);
        sent.push(text);
      }
    }
    if (changed) this.save();
    return sent;
  }
}

/** /watch, /unwatch on a CommandRegistry. */
export function registerWatchCommands(commands, watcher, knownBots) {
  commands.register({
    name: "watch",
    description: `Alert me on a bot's refusals, card timeouts and health: /watch <bot> [hours, default ${DEFAULT_HOURS}, max ${MAX_HOURS}]; /watch alone lists`,
    run: (args) => {
      const [bot, hours] = args.split(/\s+/).filter(Boolean);
      if (!bot) {
        const l = watcher.list();
        return l.length ? `Watching:\n${l.map((w) => `- ${w.bot} until ${w.until.slice(0, 16).replace("T", " ")} UTC`).join("\n")}` : "No watches. /watch <bot> [hours] starts one.";
      }
      const until = watcher.add(bot.toLowerCase(), hours, knownBots);
      return `Watching ${bot.toLowerCase()} until ${until.slice(0, 16).replace("T", " ")} UTC. Alerts come within about 3 minutes of an event.`;
    },
  });
  commands.register({
    name: "unwatch",
    description: "Stop a watch: /unwatch <bot> or /unwatch all",
    run: (args) => {
      const bot = args.split(/\s+/)[0]?.toLowerCase();
      if (!bot) return "Usage: /unwatch <bot> or /unwatch all";
      const n = watcher.remove(bot);
      return n ? `Stopped ${bot === "all" ? `${n} watch(es)` : `watching ${bot}`}.` : `No watch on ${bot}.`;
    },
  });
}
