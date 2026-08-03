#!/usr/bin/env node
// ── claw-mail: Claude Code / operator mail console (CLAW-076) ──────────────────
// A host-side console for reading and answering inter-bot mail from Claude Code,
// as a FALLBACK development channel between Mike and the oasis-claw bots.
//
// Trust model: this console sends AS a peer named "console". The relay stamps
// `from=console` from the outbox directory (a sender cannot spoof it), and the
// receiving bot treats a console message like any peer message — UNTRUSTED, a
// request to consider, NEVER an authorization. Real operator approvals for a bot
// still go through its own operator channel (Telegram), not through mail.
//
// This talks ONLY to the host mail tree; it does not touch any container or the
// gateway. The relay (claw-mail-relay) still does all routing/validation, so a
// console message obeys the same routes, caps, and audit as a bot message.
//
// Usage (run from the repo root; MAIL defaults to ~/Documents/Runes/.claw-mail):
//   node scripts/claw-mail.mjs inbox [bot]          list a bot's inbox (default: console)
//   node scripts/claw-mail.mjs unread [bot]         list only unread
//   node scripts/claw-mail.mjs read <bot> <id>      print one message body
//   node scripts/claw-mail.mjs sent <bot>           list what a bot has sent
//   node scripts/claw-mail.mjs search <bot> <query> lexical search inbox+archive
//   node scripts/claw-mail.mjs send --to <bot> --subject S --body B \
//                                   [--from console] [--kind dm|project|broadcast] \
//                                   [--items CLAW-076,CLAW-1] [--repos oasis-cloud] \
//                                   [--thread T]
//   node scripts/claw-mail.mjs audit [n]            tail the relay audit log
//   node scripts/claw-mail.mjs routes               show the route table
//
// Zero npm deps: node:fs + node:zlib only.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = process.env.CLAW_MAIL_ROOT ?? join(homedir(), "Documents/Runes/.claw-mail");
const ROUTES = process.env.CLAW_MAIL_ROUTES ?? join(homedir(), "Documents/Runes/oasis-x/oasis-claw/scripts/claw-mail-routes.json");

function die(msg) {
  console.error(msg);
  process.exit(1);
}
function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}
function botDir(bot, sub) {
  return join(ROOT, bot, sub);
}
function listEnvelopes(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f.startsWith(".") || f.startsWith("_receipt_")) continue;
    try {
      out.push(readJson(join(dir, f)));
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => (String(a.ts) < String(b.ts) ? 1 : -1));
  return out;
}
function readReadSet(bot) {
  try {
    return new Set(readJson(join(ROOT, bot, ".read.json")).readIds ?? []);
  } catch {
    return new Set();
  }
}
function fmtRow(e, read) {
  const unread = read && !read.has(e.id) ? "●" : " ";
  const work = e.work && (e.work.items?.length || e.work.repos?.length) ? ` [${[...(e.work.items ?? []), ...(e.work.repos ?? [])].join(",")}]` : "";
  return `${unread} ${e.ts ?? "?"}  ${(e.from ?? "?").padEnd(11)} ${e.id}  (${e.kind ?? "dm"}) ${e.subject ?? ""}${work}`;
}

function cmdInbox(bot = "console", unreadOnly = false) {
  const read = readReadSet(bot);
  let items = listEnvelopes(botDir(bot, "inbox"));
  if (unreadOnly) items = items.filter((e) => !read.has(e.id));
  console.log(`# ${bot} inbox — ${items.length} message(s)${unreadOnly ? " (unread)" : ""}\n`);
  for (const e of items) console.log(fmtRow(e, read));
  if (items.length === 0) console.log("(empty)");
}

function cmdRead(bot, id) {
  if (!bot || !id) die("usage: read <bot> <id>");
  const dir = botDir(bot, "inbox");
  const hit = listEnvelopes(dir).find((e) => e.id === id);
  if (!hit) die(`no message ${id} in ${bot} inbox`);
  console.log(JSON.stringify(hit, null, 2));
  // Mark read host-side via a receipt so retention can archive it (mirrors the plugin).
  emitReceipt(bot, [id]);
}

function cmdSent(bot) {
  if (!bot) die("usage: sent <bot>");
  const items = listEnvelopes(botDir(bot, "sent"));
  console.log(`# ${bot} sent — ${items.length} message(s)\n`);
  for (const e of items) console.log(fmtRow(e, null));
  if (items.length === 0) console.log("(empty)");
}

function readCorpus(bot) {
  const out = [];
  for (const e of listEnvelopes(botDir(bot, "inbox"))) out.push(e);
  const arch = botDir(bot, "archive");
  if (existsSync(arch)) {
    for (const f of readdirSync(arch)) {
      const gz = f.endsWith(".jsonl.gz");
      if (!f.endsWith(".jsonl") && !gz) continue;
      try {
        const raw = readFileSync(join(arch, f));
        const text = gz ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
        for (const line of text.split("\n")) if (line.trim()) out.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

function cmdSearch(bot, query) {
  if (!bot || !query) die("usage: search <bot> <query>");
  const terms = query.toLowerCase().match(/[a-z0-9][a-z0-9_-]+/g) ?? [];
  const scored = readCorpus(bot)
    .map((e) => {
      const hay = `${e.subject ?? ""} ${e.body ?? ""} ${e.from ?? ""} ${(e.work?.items ?? []).join(" ")} ${(e.work?.repos ?? []).join(" ")}`.toLowerCase();
      const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (String(a.e.ts) < String(b.e.ts) ? 1 : -1));
  console.log(`# search "${query}" in ${bot} — ${scored.length} hit(s)\n`);
  for (const { e, score } of scored.slice(0, 30)) console.log(`(${score}) ${fmtRow(e, null)}`);
  if (scored.length === 0) console.log("(no matches)");
}

function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      f[key] = val;
    }
  }
  return f;
}

function cmdSend(argv) {
  const f = parseFlags(argv);
  const from = f.from ?? "console";
  const to = f.to;
  if (!to) die("usage: send --to <bot> --subject S --body B [--from console] [--kind dm] [--items a,b] [--repos x] [--thread T]");
  if (!existsSync(botDir(from, "outbox"))) mkdirSync(botDir(from, "outbox"), { recursive: true });
  const env = {
    id: "m_" + randomBytes(12).toString("hex"),
    to: [to],
    kind: f.kind ?? "dm",
    subject: f.subject ?? "",
    body: f.body ?? "",
    refs: [],
    work: { items: f.items ? f.items.split(",").filter(Boolean) : [], repos: f.repos ? f.repos.split(",").filter(Boolean) : [] },
    thread_id: f.thread ?? "",
    ts: new Date().toISOString(),
  };
  const dir = botDir(from, "outbox");
  const tmp = join(dir, `.${env.id}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(env, null, 2));
  renameSync(tmp, join(dir, `${env.id}.json`));
  console.log(`queued ${env.id}: ${from} → ${to} (${env.kind}) "${env.subject}"`);
  console.log(`The relay delivers it on its next tick if the route ${from}→${to} exists.`);
}

function emitReceipt(bot, ids) {
  try {
    const dir = botDir(bot, "outbox");
    mkdirSync(dir, { recursive: true });
    const name = `_receipt_${randomBytes(8).toString("hex")}.json`;
    const tmp = join(dir, `.${name}.tmp`);
    writeFileSync(tmp, JSON.stringify({ type: "read_receipt", ids, ts: new Date().toISOString() }));
    renameSync(tmp, join(dir, name));
  } catch {
    /* best-effort */
  }
}

function cmdAudit(n = 40) {
  const p = join(ROOT, "relay-audit.jsonl");
  if (!existsSync(p)) die("no relay-audit.jsonl (relay not running yet?)");
  const lines = readFileSync(p, "utf8").trim().split("\n");
  for (const l of lines.slice(-Number(n))) console.log(l);
}

function cmdRoutes() {
  const r = readJson(ROUTES);
  console.log("# routes\n");
  for (const rt of r.routes ?? []) console.log(`${(rt.from ?? "?").padEnd(11)} → ${rt.to}`);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "inbox":
    cmdInbox(rest[0] ?? "console", false);
    break;
  case "unread":
    cmdInbox(rest[0] ?? "console", true);
    break;
  case "read":
    cmdRead(rest[0], rest[1]);
    break;
  case "sent":
    cmdSent(rest[0]);
    break;
  case "search":
    cmdSearch(rest[0], rest.slice(1).join(" "));
    break;
  case "send":
    cmdSend(rest);
    break;
  case "audit":
    cmdAudit(rest[0]);
    break;
  case "routes":
    cmdRoutes();
    break;
  default:
    console.log("commands: inbox [bot] | unread [bot] | read <bot> <id> | sent <bot> | search <bot> <query> | send --to <bot> --subject S --body B [...] | audit [n] | routes");
}
