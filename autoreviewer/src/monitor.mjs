// Fleet monitoring commands (CLAW-122): /fleet, /bot, /denials, /mail, /ledger.
//
// They read the sanitized snapshot that scripts/claw-fleet-snapshot.mjs writes
// on the Mac every 2 minutes (metadata only; health-only for bots whose data
// rule forbids more). This bot has no Docker access and reads no bot files.

import { existsSync, readFileSync, statSync } from "node:fs";

const STALE_MS = 10 * 60 * 1000;
const TEXT_MAX = 3900;

function ago(iso, now) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function fit(text) {
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text;
}

export function loadSnapshot(path, now = Date.now()) {
  if (!path || !existsSync(path)) return { snap: null, note: "No fleet snapshot yet (scripts/claw-fleet-snapshot.mjs on the Mac writes it)." };
  try {
    const snap = JSON.parse(readFileSync(path, "utf8"));
    const age = now - Date.parse(snap.generated_at ?? statSync(path).mtime.toISOString());
    return { snap, note: age > STALE_MS ? `WARNING: snapshot is ${Math.round(age / 60000)} min old; the Mac exporter may be stopped.\n` : "" };
  } catch {
    return { snap: null, note: "The fleet snapshot could not be read." };
  }
}

function verdictLine(v) {
  const c = v ?? {};
  return `${c.allow ?? 0} allow, ${c.escalate ?? 0} escalate, ${c.deny ?? 0} deny`;
}

export function fleetText(snap, now = Date.now()) {
  const lines = [`FLEET at ${snap.generated_at.slice(11, 16)} UTC`];
  for (const [bot, b] of Object.entries(snap.bots)) {
    const state = b.status !== "running" ? b.status.toUpperCase() : (b.health ?? "running");
    if (b.health_only) {
      lines.push(`${bot}: ${state} (health only)`);
      continue;
    }
    const r = b.reviewer ?? {};
    const st = b.status_file?.filled ? `status ${ago(b.status_file.updated_at, now)}` : "no status yet";
    lines.push(`${bot}: ${state} | last tool ${ago(r.lastTs, now)}${r.lastTool ? ` (${r.lastTool})` : ""} | 24h ${verdictLine(r.verdicts24h)} | ${st}`);
  }
  return fit(lines.join("\n"));
}

export function botText(snap, bot, now = Date.now()) {
  const b = snap.bots[bot];
  if (!b) return `No bot "${bot}". Bots: ${Object.keys(snap.bots).join(", ")}`;
  const lines = [`${bot.toUpperCase()}: ${b.status}${b.health ? ` / ${b.health}` : ""}, up since ${b.started_at ?? "?"}, image ${b.image ?? "?"}`];
  if (b.health_only) return fit(lines.concat("Health only: this bot's data rule keeps its activity out of the snapshot.").join("\n"));
  const r = b.reviewer ?? {};
  const sessions = Object.entries(r.sessions1h ?? {}).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  const cards = Object.entries(r.cards24h ?? {}).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  lines.push(
    `Last tool: ${r.lastTool ?? "-"} (${ago(r.lastTs, now)}). Calls in the last hour by trigger: ${sessions}.`,
    `24h: ${r.calls24h ?? 0} calls; ${verdictLine(r.verdicts24h)}; cards ${cards}; grant allows ${r.grantAllows24h ?? 0}; empty judge replies ${r.emptyL2_24h ?? 0}; fail-closed ${r.failClosed24h ?? 0}.`,
    `Mail 24h: sent ${snap.mail.sent24h?.[bot] ?? 0}, received ${snap.mail.received24h?.[bot] ?? 0}.`,
  );
  if (b.status_file?.filled) lines.push("", `STATUS FILE (${ago(b.status_file.updated_at, now)}):`, b.status_file.text);
  else lines.push("", "No status file written yet (/reach/fleet/status).");
  const recent = (r.recent ?? []).slice(0, 3);
  if (recent.length) {
    lines.push("", "Latest refusals:");
    for (const x of recent) lines.push(`- ${x.ts.slice(11, 16)} ${x.verdict} ${x.tool} [${x.principle}] ${x.reason}`);
  }
  return fit(lines.join("\n"));
}

export function denialsText(snap, only) {
  const rows = [];
  for (const [bot, b] of Object.entries(snap.bots)) {
    if (only && bot !== only) continue;
    for (const x of b.reviewer?.recent ?? []) rows.push({ bot, ...x });
  }
  rows.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  if (!rows.length) return only ? `No refusals for ${only} in the last 24 h.` : "No refusals in the last 24 h.";
  const lines = [`REFUSALS, last 24 h${only ? ` (${only})` : ""}, newest first:`];
  for (const x of rows.slice(0, 15)) {
    lines.push(`- ${x.ts.slice(5, 16).replace("T", " ")} ${x.bot} ${x.verdict}${x.unattended ? " (unattended)" : ""} ${x.tool} [${x.principle}]\n  ${x.reason}`);
  }
  return fit(lines.join("\n"));
}

export function mailText(snap, now = Date.now()) {
  const m = snap.mail;
  const lines = [`MAIL, last 24 h (hop budget ${m.hop_budget ?? "?"} per thread)`];
  const sent = Object.entries(m.sent24h ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
  lines.push(`Sent: ${sent || "none"}`);
  lines.push("", "Active threads:");
  for (const t of m.threads ?? []) lines.push(`- ${t.thread}: ${t.hops} hops, last ${t.last_from} ${ago(t.last_at, now)}${t.budget_exceeded ? " BUDGET EXCEEDED" : ""}`);
  if (!(m.threads ?? []).length) lines.push("- none");
  if ((m.refusals24h ?? []).length) {
    lines.push("", "Relay refusals:");
    for (const r of m.refusals24h) lines.push(`- ${r.ts.slice(11, 16)} ${r.from}: ${r.reason}${r.thread ? ` (${r.thread})` : ""}`);
  }
  return fit(lines.join("\n"));
}

export function ledgerText(snap) {
  const lines = ["INFRA LEDGER (Mike's host file; the applier bot applies):"];
  for (const e of snap.ledgers?.infra ?? []) lines.push(`- ${e.id} [${e.status}] ${e.title} (for ${e.requesters.join(", ") || "-"}; until ${e.expires ?? "-"})`);
  return fit(lines.join("\n"));
}

/** Register the commands on a CommandRegistry. */
export function registerMonitorCommands(commands, snapshotPath, now = () => Date.now()) {
  const withSnap = (fn) => () => {
    const { snap, note } = loadSnapshot(snapshotPath, now());
    return snap ? note + fn(snap) : note;
  };
  commands.register({ name: "fleet", description: "Every bot: health, last activity, reviewer verdicts, status file age", run: withSnap((s) => fleetText(s, now())) });
  commands.register({
    name: "bot",
    description: "One bot in detail: /bot <name>",
    run: (args) => {
      const name = args.split(/\s+/)[0]?.toLowerCase();
      if (!name) return "Usage: /bot <name>";
      return withSnap((s) => botText(s, name, now()))();
    },
  });
  commands.register({
    name: "denials",
    description: "Recent reviewer refusals: /denials [bot]",
    run: (args) => withSnap((s) => denialsText(s, args.split(/\s+/)[0]?.toLowerCase() || null))(),
  });
  commands.register({ name: "mail", description: "Mail threads, hop counts and relay refusals (24 h)", run: withSnap((s) => mailText(s, now())) });
  commands.register({ name: "ledger", description: "Infra ledger entries and their state", run: withSnap(ledgerText) });
}
