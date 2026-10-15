// Morning digest and open-work commands (CLAW-124): /open, /needs, /brief, and
// the weekday 08:00 (New York) digest.
//
// Inputs: the Mac's sanitized fleet snapshot (STATUS.md fields, morning-job
// state, the coordinator's BRIEF-<date>.md) and this bot's own grant ledger
// (directives). No LLM: the digest always arrives, even when the coordinator's
// narrative brief is late or missing — and then it says so.
//
// STATUS.md and the brief are bot-written text. The snapshot redacts key-shaped
// strings and cuts them short; here they are shown to Mike only, never acted on.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CALLBACK } from "./cards.mjs";
import { loadSnapshot } from "./monitor.mjs";

const TEXT_MAX = 3900;
const TZ = "America/New_York";
export const DIGEST_HOUR = 8;
// After this New York hour a missed digest is skipped for the day (the bot was down).
const DIGEST_LATEST_HOUR = 11;
const RENEW_WITHIN_MS = 48 * 3600 * 1000;

function fit(text) {
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text;
}

/** New York calendar parts for a time. */
export function nyParts(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), weekday: p.weekday };
}

function nyTime(iso) {
  if (!iso) return "-";
  const p = nyParts(Date.parse(iso));
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function left(ms) {
  const h = Math.max(0, Math.round(ms / 3600000));
  return h >= 48 ? `${Math.round(h / 24)} d` : `${h} h`;
}

function activeDirectives(ledger) {
  return ledger.list({ statuses: ["active"] }).filter((g) => g.kind === "directive");
}

function laneBots(snap) {
  return Object.entries(snap.bots).filter(([, b]) => !b.health_only);
}

function morningLine(b) {
  const jobs = Array.isArray(b.morning) ? b.morning : [];
  const work = jobs.find((j) => j.key === "fleet-morning-work");
  if (!work) return "no morning job";
  if (!work.last_at) return `morning job not run yet (next ${nyTime(work.next_at)})`;
  return `morning ${work.last_status ?? "?"} at ${nyTime(work.last_at)}${work.last_minutes != null ? ` (${work.last_minutes} min)` : ""}${work.errors ? `, ${work.errors} errors in a row` : ""}`;
}

/** The digest text and its keyboard. */
export function digestMessage(snap, ledger, now = Date.now()) {
  const today = nyParts(now).date;
  const lines = [`MORNING DIGEST ${today} (New York ${nyTime(new Date(now).toISOString())})`];
  const dirs = activeDirectives(ledger);
  const covered = new Set(dirs.map((d) => d.grantees[0]));
  const renew = [];
  lines.push("", "DIRECTIVES");
  if (!dirs.length) lines.push("- none active. Morning sessions only read and rewrite STATUS.md. Set one: /directive <bot> <goal> | may: … | must not: …");
  for (const d of dirs) {
    const ms = Date.parse(d.expires) - now;
    if (ms <= RENEW_WITHIN_MS) renew.push(d);
    lines.push(`- ${d.id} ${d.grantees[0]}${d.lane ? ` (${d.lane})` : ""}: ${left(ms)} left${ms <= RENEW_WITHIN_MS ? " (renew)" : ""}`);
  }
  const without = laneBots(snap).map(([bot]) => bot).filter((bot) => !covered.has(bot));
  if (dirs.length && without.length) lines.push(`- no directive: ${without.join(", ")}`);

  lines.push("", "LANES");
  const silent = [];
  const needs = [];
  let stale = 0;
  for (const [bot, b] of laneBots(snap)) {
    const sf = b.status_file;
    const p = sf?.parsed;
    if (!sf?.updated_today) silent.push(bot);
    const open = p?.open ?? [];
    const st = open.filter((o) => o.stale).length;
    stale += st;
    for (const n of p?.needs ?? []) needs.push(`${bot}: ${n}`);
    const health = b.status !== "running" ? ` ${String(b.status).toUpperCase()}` : "";
    lines.push(`${bot}${health}: ${morningLine(b)} | ${open.length} open${st ? `, ${st} STALE` : ""} | ${(p?.needs ?? []).length} needs`);
    if (p?.status) lines.push(`  ${p.status}`);
    if (open[0]) lines.push(`  top: ${open[0].item}${open[0].next ? ` -> ${open[0].next}` : ""}`);
  }
  if (silent.length) lines.push("", `SILENT (no STATUS.md update today): ${silent.join(", ")}`);

  lines.push("", `NEEDS FROM MIKE (${needs.length})`);
  if (!needs.length) lines.push("- none");
  for (const n of needs.slice(0, 12)) lines.push(`- ${n}`);
  if (needs.length > 12) lines.push(`- … ${needs.length - 12} more: /needs`);

  const refusals = laneBots(snap)
    .map(([bot, b]) => [bot, (b.reviewer?.verdicts24h?.deny ?? 0) + (b.reviewer?.verdicts24h?.escalate ?? 0)])
    .filter(([, n]) => n > 0);
  lines.push("", `REFUSALS AND CARDS, last 24 h: ${refusals.length ? refusals.map(([b, n]) => `${b} ${n}`).join(", ") : "none"}${refusals.length ? " (/denials)" : ""}`);

  const brief = snap.brief;
  lines.push("", brief?.date === today ? `BRIEF: the coordinator wrote BRIEF-${today}.md at ${nyTime(brief.updated_at)}; it follows.` : `BRIEF: no BRIEF-${today}.md from the coordinator today${briefJobNote(snap)}.`);
  lines.push("More: /open, /needs, /fleet, /bot <name>, and the observatory Approvals & work tab.");

  const rows = [];
  for (const d of renew) rows.push([{ text: `Renew ${d.id} (${d.grantees[0]}) 7 d`, callback_data: CALLBACK.dirRenew(d.id) }]);
  const watch = [...new Set([...silent, ...refusals.map(([b]) => b)])].slice(0, 4);
  if (watch.length) rows.push(watch.map((bot) => ({ text: `Watch ${bot} 8 h`, callback_data: CALLBACK.watch(bot) })));
  return { text: fit(lines.join("\n")), replyMarkup: rows.length ? { inline_keyboard: rows } : undefined, stale };
}

function briefJobNote(snap) {
  for (const [, b] of laneBots(snap)) {
    const j = (Array.isArray(b.morning) ? b.morning : []).find((x) => x.key === "fleet-morning-brief");
    if (j) return j.last_at ? ` (brief job: ${j.last_status ?? "?"} at ${nyTime(j.last_at)})` : " (brief job has not run yet)";
  }
  return " (no brief job is set up)";
}

/** The coordinator's narrative, as a second message (bot-written text, shown as data). */
export function briefMessage(snap, now = Date.now()) {
  const b = snap.brief;
  if (!b || b.date !== nyParts(now).date) return null;
  return fit(`BRIEF-${b.date}.md (written by the coordinator bot):\n\n${b.text}`);
}

export function openText(snap, only) {
  const lines = [`OPEN WORK${only ? ` (${only})` : ""}, from each STATUS.md:`];
  let any = false;
  for (const [bot, b] of laneBots(snap)) {
    if (only && bot !== only) continue;
    const p = b.status_file?.parsed;
    const open = p?.open ?? [];
    lines.push("", `${bot} (STATUS.md ${b.status_file?.updated_today ? "updated today" : "NOT updated today"}):`);
    if (!open.length) lines.push(p ? "- no OPEN list yet" : "- no status written yet");
    for (const o of open) {
      any = true;
      lines.push(`- ${o.stale ? "STALE " : ""}${o.item}${o.next ? ` -> ${o.next}` : ""}${o.directive ? ` [${o.directive}]` : ""}${o.since ? ` (since ${o.since})` : ""}`);
    }
  }
  if (only && lines.length === 1) return `No lane bot "${only}".`;
  if (!any && !only) lines.push("", "No bot has an OPEN list yet. The morning sessions write them (PLAYBOOK section 3).");
  return fit(lines.join("\n"));
}

export function needsText(snap) {
  const lines = ["NEEDS FROM MIKE, from each STATUS.md:"];
  let n = 0;
  for (const [bot, b] of laneBots(snap)) {
    for (const x of b.status_file?.parsed?.needs ?? []) {
      lines.push(`- ${bot}: ${x}`);
      n++;
    }
  }
  if (!n) lines.push("- none");
  return fit(lines.join("\n"));
}

/** Sends the digest once per New York weekday, at or after 08:00. */
export class DigestScheduler {
  constructor({ stateFile, snapshotPath, ledger, send, now = Date.now, hour = DIGEST_HOUR }) {
    this.stateFile = stateFile;
    this.snapshotPath = snapshotPath;
    this.ledger = ledger;
    this.send = send;
    this.now = now;
    this.hour = hour;
    this.state = { last_sent: null };
    try {
      if (existsSync(stateFile)) this.state = { ...this.state, ...JSON.parse(readFileSync(stateFile, "utf8")) };
    } catch {
      // A broken state file means "not sent yet today": the worst case is one extra digest.
    }
  }

  save() {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.stateFile);
  }

  due() {
    const p = nyParts(this.now());
    if (p.weekday === "Sat" || p.weekday === "Sun") return false;
    if (p.hour < this.hour || p.hour >= DIGEST_LATEST_HOUR) return false;
    return this.state.last_sent !== p.date;
  }

  /** One digest now (also /brief). Returns false when there is no snapshot. */
  async sendNow() {
    const now = this.now();
    const { snap, note } = loadSnapshot(this.snapshotPath, now);
    if (!snap) {
      await this.send(`MORNING DIGEST: ${note}`);
      return false;
    }
    const m = digestMessage(snap, this.ledger, now);
    await this.send(note + m.text, m.replyMarkup);
    const brief = briefMessage(snap, now);
    if (brief) await this.send(brief);
    return true;
  }

  async tick() {
    if (!this.due()) return false;
    // Mark first: a send that throws must not repeat every minute.
    this.state.last_sent = nyParts(this.now()).date;
    this.save();
    await this.sendNow();
    return true;
  }
}

/** /open, /needs, /brief on a CommandRegistry. */
export function registerDigestCommands(commands, scheduler, snapshotPath, now = () => Date.now()) {
  const withSnap = (fn) => () => {
    const { snap, note } = loadSnapshot(snapshotPath, now());
    return snap ? note + fn(snap) : note;
  };
  commands.register({
    name: "open",
    description: "Open work items from each bot's STATUS.md, with stale flags: /open [bot]",
    run: (args) => withSnap((s) => openText(s, args.split(/\s+/)[0]?.toLowerCase() || null))(),
  });
  commands.register({ name: "needs", description: "Every NEEDS FROM MIKE line from the bots' STATUS.md files", run: withSnap(needsText) });
  commands.register({
    name: "brief",
    description: `Send the morning digest now (it also comes by itself at 0${DIGEST_HOUR}:00 New York on weekdays)`,
    run: async () => {
      await scheduler.sendNow();
    },
  });
}

