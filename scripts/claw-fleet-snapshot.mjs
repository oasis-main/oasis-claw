#!/usr/bin/env node
// ── claw-fleet-snapshot (CLAW-122) ───────────────────────────────────────────
// Writes a SANITIZED fleet snapshot for the autoreviewer bot's monitoring
// commands (/fleet, /bot, /denials, /mail, /ledger) and the observatory's
// approvals panel. Runs on the Mac (launchd, every 2 minutes).
//
// TRUST MODEL
//   - Metadata only: health, times, counts, reviewer verdicts with the rule
//     name and a SHORT reason, mail routing events, ledger entries. No tool
//     parameters, no message bodies, no memory, no transcripts.
//   - Every free-text field passes through redact() (key-shaped strings) and
//     is cut short.
//   - Bots listed in config.json "health_only" (beside the snapshot, outside the
//     repo) or in OASIS_SNAPSHOT_HEALTH_ONLY get health only: use it for a bot
//     whose data rule forbids reading its audit rows.
//   - Output: ~/Library/Application Support/oasis-x/fleet-snapshot/snapshot.json
//     (mode 644). Only the autoreviewer bot mounts that folder, read-only.
//
// Usage: node scripts/claw-fleet-snapshot.mjs [--print]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SUPPORT = join(homedir(), "Library", "Application Support", "oasis-x");
const OUT_DIR = process.env.OASIS_SNAPSHOT_DIR || join(SUPPORT, "fleet-snapshot");
const CONTAINERS = process.env.OASIS_SNAPSHOT_CONTAINERS || join(SUPPORT, "autoreviewer", "containers.json");
const MAIL = process.env.CLAW_MAIL_ROOT || join(homedir(), "Documents", "Runes", ".claw-mail");
const FLEET_BOARD = process.env.OASIS_FLEET_BOARD || join(homedir(), "Documents", "Runes", "oasis-x", ".swarm", "fleet");
const HEALTH_ONLY = new Set([
  ...(process.env.OASIS_SNAPSHOT_HEALTH_ONLY ?? "").split(","),
  ...(((() => { try { return JSON.parse(readFileSync(join(OUT_DIR, "config.json"), "utf8")).health_only; } catch { return []; } })()) ?? []),
].map((s) => String(s).trim()).filter(Boolean));
const DAY = 86_400_000;

const KEYLIKE = [
  /\b[rs]k_(?:live|test)_[0-9a-z]{6,}/gi,
  /\bgh[pousr]_[0-9a-z]{20,}/gi,
  /\bgithub_pat_[0-9a-z_]{20,}/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abpr]-[0-9a-z-]{10,}/gi,
  /\bdop_v1_[0-9a-f]{20,}/gi,
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];
export function redact(s, max = 160) {
  let t = String(s ?? "").replace(/\s+/g, " ").trim();
  for (const re of KEYLIKE) t = t.replace(re, "[redacted]");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function readJson(p, dflt) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return dflt;
  }
}

function tailText(p, bytes) {
  if (!existsSync(p)) return "";
  const size = statSync(p).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(p, "r");
  const buf = Buffer.alloc(size - start);
  readSync(fd, buf, 0, buf.length, start);
  closeSync(fd);
  const text = buf.toString("utf8");
  return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
}

function docker(args, timeout = 30_000) {
  return execFileSync("docker", args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
}

function health(container) {
  try {
    const [status, healthStatus, started, image] = docker([
      "inspect", "-f", "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.StartedAt}}|{{.Image}}", container,
    ]).trim().split("|");
    return { status, health: healthStatus || null, started_at: started.slice(0, 19) + "Z", image: image.replace("sha256:", "").slice(0, 12) };
  } catch {
    return { status: "missing", health: null, started_at: null, image: null };
  }
}

// Runs INSIDE the bot container: last 4 MB of the reviewer audit, metadata only.
const COLLECTOR = `
const fs=require("fs");const f="/home/node/.openclaw/logs/reviewer/reviewer-audit.jsonl";
let txt="";try{const s=fs.statSync(f).size;const st=Math.max(0,s-4*1024*1024);const fd=fs.openSync(f,"r");const b=Buffer.alloc(s-st);fs.readSync(fd,b,0,b.length,st);fs.closeSync(fd);txt=b.toString("utf8");if(st>0)txt=txt.slice(txt.indexOf("\\n")+1);}catch(e){}
const now=Date.now(),DAY=86400000;const o={calls24h:0,verdicts24h:{},cards24h:{},grantAllows24h:0,emptyL2_24h:0,failClosed24h:0,lastTs:null,lastTool:null,sessions1h:{},recent:[]};
for(const l of txt.split("\\n")){if(!l)continue;let r;try{r=JSON.parse(l)}catch{continue}const t=Date.parse(r.ts);if(!(t>0))continue;
if(r.phase==="approval_resolution"){if(now-t<=DAY)o.cards24h[r.resolution]=(o.cards24h[r.resolution]||0)+1;continue}
if(r.phase!=="before_tool_call")continue;
if(!o.lastTs||r.ts>o.lastTs){o.lastTs=r.ts;o.lastTool=r.toolName||null}
if(now-t<=3600000){const k=String(r.sessionKey||"");const kind=k.includes(":hook:reach-")?"mail":k.includes(":cron:")?"cron":k.includes("telegram")?"telegram":"other";o.sessions1h[kind]=(o.sessions1h[kind]||0)+1}
if(now-t>DAY)continue;o.calls24h++;const v=String(r.verdict||"?");o.verdicts24h[v]=(o.verdicts24h[v]||0)+1;
if(r.grantDowngrade)o.grantAllows24h++;if(r.l2EmptyReplies)o.emptyL2_24h++;if(r.l2FailClosed)o.failClosed24h++;
if(v!=="allow")o.recent.push({ts:r.ts,verdict:v,tool:r.toolName||null,principle:r.principle||null,unattended:!!r.unattended,reason:String(r.reason||"").slice(0,400)})}
o.recent=o.recent.slice(-10).reverse();process.stdout.write(JSON.stringify(o));`;

function reviewerSummary(container) {
  try {
    const o = JSON.parse(docker(["exec", container, "node", "-e", COLLECTOR], 60_000));
    o.recent = o.recent.map((r) => ({ ...r, reason: redact(r.reason, 160) }));
    return o;
  } catch (err) {
    return { error: redact(err.message, 120) };
  }
}

// ── CLAW-124: open items, NEEDS FROM MIKE, morning runs, the brief ──────────
// Day boundaries are New York days: the morning sessions and the 08:00 digest
// run on New York time.
export function nyDate(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** STATUS.md (PLAYBOOK section 3) -> fields. Unknown lines are ignored. */
export function parseStatus(text) {
  const out = { status: null, next: null, needs: [], blockers: null, open: [] };
  let inOpen = false;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (/^#+\s*OPEN\b/i.test(line)) { inOpen = true; continue; }
    if (/^#+\s/.test(line)) { inOpen = false; continue; }
    if (inOpen) {
      const m = /^[-*]\s+(.+)$/.exec(line);
      if (!m) continue;
      const parts = m[1].split("|").map((x) => x.trim());
      const field = (name) => parts.find((x) => x.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim() || null;
      const directive = field("directive");
      out.open.push({ item: redact(parts[0], 120), next: field("next") ? redact(field("next"), 160) : null, directive: directive && /^DIR-\d+$/i.test(directive) ? directive.toUpperCase() : null });
      continue;
    }
    const kv = /^(STATUS|NEXT|NEEDS FROM MIKE|BLOCKERS):\s*(.*)$/i.exec(line);
    if (!kv) continue;
    const key = kv[1].toUpperCase(), val = kv[2].trim();
    if (key === "STATUS") out.status = redact(val, 200);
    else if (key === "NEXT") out.next = redact(val, 200);
    else if (key === "BLOCKERS") out.blockers = /^none\.?$/i.test(val) ? null : redact(val, 200);
    else if (val && !/^none\.?$/i.test(val)) out.needs.push(redact(val, 200));
  }
  out.open = out.open.slice(0, 12);
  out.needs = out.needs.slice(0, 8);
  return out;
}

/**
 * Stale = the same open item with the same next step on two or more New York days.
 * history: { [bot]: { [item]: { first_seen, next, next_since } } } (mutated).
 */
export function markStale(bot, open, history, today) {
  const prev = history[bot] ?? {};
  const cur = {};
  for (const o of open) {
    const h = prev[o.item];
    const nextSince = h && h.next === o.next ? h.next_since : today;
    cur[o.item] = { first_seen: h?.first_seen ?? today, next: o.next, next_since: nextSince };
    const days = Math.round((Date.parse(today) - Date.parse(nextSince)) / 86_400_000);
    o.since = cur[o.item].first_seen;
    o.stale = days >= 2;
  }
  history[bot] = cur;
  return open;
}

function statusFile(bot, history, today) {
  const p = join(FLEET_BOARD, "status", bot, "STATUS.md");
  if (!existsSync(p)) return null;
  const st = statSync(p);
  const text = readFileSync(p, "utf8");
  // The template still in place means the bot has not written yet.
  const filled = /^STATUS:\s*\S/m.test(text) && !/^STATUS: <one line>/m.test(text);
  const parsed = filled ? parseStatus(text) : null;
  if (parsed) markStale(bot, parsed.open, history, today);
  return {
    updated_at: st.mtime.toISOString().slice(0, 19) + "Z",
    updated_today: nyDate(st.mtimeMs) === today,
    filled,
    text: filled ? redact(text.replace(/^#.*\n/, "").replace(/\n#+\s*OPEN[\s\S]*$/i, ""), 900) : null,
    parsed,
  };
}

// `openclaw cron list` costs about 4 s per bot, so the morning-job state is
// refreshed at most every 10 minutes and cached beside the snapshot.
const MORNING_CACHE_MS = 10 * 60 * 1000;
function morningJobs(containers, cache) {
  if (cache.at && Date.now() - cache.at < MORNING_CACHE_MS) return cache.bots;
  const out = {};
  for (const [container, bot] of Object.entries(containers)) {
    if (HEALTH_ONLY.has(bot)) continue;
    try {
      const d = JSON.parse(docker(["exec", container, "openclaw", "cron", "list", "--json"], 30_000));
      const jobs = (Array.isArray(d) ? d : d.jobs ?? []).filter((j) => String(j.declarationKey ?? "").startsWith("fleet-morning-"));
      out[bot] = jobs.map((j) => ({
        key: j.declarationKey,
        enabled: !!j.enabled,
        cron: j.schedule?.expr ?? null,
        next_at: j.state?.nextRunAtMs ? new Date(j.state.nextRunAtMs).toISOString() : null,
        last_at: j.state?.lastRunAtMs ? new Date(j.state.lastRunAtMs).toISOString() : null,
        last_status: j.state?.lastStatus ?? null,
        last_minutes: j.state?.lastDurationMs != null ? Math.round(j.state.lastDurationMs / 60000) : null,
        errors: j.state?.consecutiveErrors ?? 0,
      }));
    } catch (err) {
      out[bot] = { error: redact(err.message, 100) };
    }
  }
  cache.at = Date.now();
  cache.bots = out;
  return out;
}

/** The newest BRIEF-<date>.md (the coordinator writes it at 07:45). Bot-written text: redacted, cut. */
function latestBrief() {
  let names = [];
  try { names = readdirSync(FLEET_BOARD).filter((n) => /^BRIEF-\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort(); } catch { return null; }
  const name = names.at(-1);
  if (!name) return null;
  const p = join(FLEET_BOARD, name);
  const raw = readFileSync(p, "utf8");
  const text = String(raw).split("\n").map((l) => redact(l, 400)).join("\n").slice(0, 3000);
  return { date: name.slice(6, 16), updated_at: statSync(p).mtime.toISOString().slice(0, 19) + "Z", text };
}

function mailSummary() {
  const now = Date.now();
  const threads = readJson(join(MAIL, "threads.json"), {}).threads ?? {};
  const sent = {}, received = {}, refusals = [];
  for (const line of tailText(join(MAIL, "relay-audit.jsonl"), 4 * 1024 * 1024).split("\n")) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const t = Date.parse(r.ts);
    if (!(now - t <= DAY)) continue;
    if (r.evt === "processed") {
      sent[r.from] = (sent[r.from] ?? 0) + 1;
      for (const to of r.delivered ?? []) received[to] = (received[to] ?? 0) + 1;
    } else if (r.evt === "refused") {
      refusals.push({ ts: r.ts, from: r.from, reason: redact(r.reason, 60), thread: redact(r.thread_id ?? "", 60) });
    }
  }
  const active = Object.entries(threads)
    .filter(([, v]) => v.lastTs && now - Date.parse(v.lastTs) <= DAY)
    .map(([id, v]) => ({ thread: redact(id, 60), hops: v.count ?? 0, last_from: v.lastFrom ?? null, last_at: v.lastTs, budget_exceeded: !!v.budgetExceeded }))
    .sort((a, b) => (a.last_at < b.last_at ? 1 : -1))
    .slice(0, 15);
  const budget = readJson(process.env.CLAW_MAIL_ROUTES || join(homedir(), "Documents", "Runes", "oasis-x", "oasis-claw", "scripts", "claw-mail-routes.json"), {}).threadHopBudget ?? null;
  return { sent24h: sent, received24h: received, refusals24h: refusals.slice(-10).reverse(), threads: active, hop_budget: budget };
}

function ledgers() {
  const infra = readJson(join(SUPPORT, "approvals", "infra-ledger.json"), { entries: [] }).entries.map((e) => ({
    id: e.id, status: e.status, title: redact(e.title, 100), requesters: e.requesters ?? [], expires: e.expires ?? null,
  }));
  return { infra };
}

export function build({ persist = true } = {}) {
  const containers = readJson(CONTAINERS, {});
  const today = nyDate(Date.now());
  const historyPath = join(OUT_DIR, "open-history.json");
  const history = readJson(historyPath, {});
  const cachePath = join(OUT_DIR, "morning-cache.json");
  const cache = readJson(cachePath, {});
  const morning = morningJobs(containers, cache);
  const bots = {};
  for (const [container, bot] of Object.entries(containers)) {
    const h = health(container);
    bots[bot] = HEALTH_ONLY.has(bot)
      ? { ...h, health_only: true }
      : {
          ...h,
          reviewer: h.status === "running" ? reviewerSummary(container) : null,
          status_file: statusFile(bot, history, today),
          morning: morning[bot] ?? [],
        };
  }
  if (persist) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(historyPath, JSON.stringify(history, null, 2) + "\n");
    writeFileSync(cachePath, JSON.stringify(cache) + "\n");
  }
  return { generated_at: new Date().toISOString(), today, bots, brief: latestBrief(), mail: mailSummary(), ledgers: ledgers() };
}

// pathToFileURL, not `file://${argv[1]}`: the installed copy lives under
// "Application Support", and the space is %20 in import.meta.url.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const snap = build({ persist: !process.argv.includes("--print") });
  if (process.argv.includes("--print")) {
    process.stdout.write(JSON.stringify(snap, null, 2) + "\n");
  } else {
    mkdirSync(OUT_DIR, { recursive: true });
    const tmp = join(OUT_DIR, ".snapshot.json.tmp");
    writeFileSync(tmp, JSON.stringify(snap, null, 2) + "\n", { mode: 0o644 });
    renameSync(tmp, join(OUT_DIR, "snapshot.json"));
    console.log(`[claw-fleet-snapshot] wrote ${Object.keys(snap.bots).length} bots to ${join(OUT_DIR, "snapshot.json")}`);
  }
}
