// ── claw-observatory-authority: the Authority view (Mike, 2026-11-03) ───────
// Step 4 of the identity plan (shared notes "feature-exploration 2026-10-31",
// "How Mike manages it"): the authority hub of scripts/claw-authority.mjs on
// one page.
//   - The instances: per bot, the level in force, the reviewer chain and its
//     health, the home hub, the live grants and directives, the restrictions,
//     and the state of the bot's own copy of the view.
//   - The hub's cards: keep or let expire, a storm, a ledger record that is
//     not legal, a log fault, a bot with no current view, a red reviewer, a
//     hub certificate near its end. The page puts them in one queue with the
//     approval cards that the autoreviewer also sends to Telegram.
//   - Freeze, restrict, lift and keep.
//   - The signed history of the control, restrictions and ledger streams.
//
// WRITES: restrict, lift and keep each append ONE event that Mike's root key
// signs, through claw-authority.mjs. The root key is in the Secure Enclave:
// each signature asks for Touch ID on the Mac, with a text that the tool
// builds from the event (scripts/authority/oasis-root-key.swift). So the page
// only asks; Touch ID is the confirmation outside the page. One signature at
// a time. Only a lift loosens, and only Mike's key lifts. This module never
// writes a bot view: the authority daemon stays the only writer, and it sends
// a change of the restrictions stream to the bots within about 1 s
// (claw-authority.mjs runDaemon).
//
// READS: the streams (verified as `claw-authority verify` does), each bot's
// view file on the Mac, the daemon's two modes from its launchd plist, the
// /reach/authority mount from `docker inspect`, and counts from each bot's
// reviewer audit (collectReviewerHealth, inside the bot: counts and times
// only, no tool parameters and no reasons).
//
// Loaded only by `serve` (dynamic import), as claw-observatory-access.mjs.

import fs from "node:fs";
import path from "node:path";
import {
  LEVELS,
  STREAMS,
  TARGET_RE,
  VIEW_FILE,
  appendEvent,
  canonical,
  enclaveSigner,
  evaluateRestrictions,
  loadAuthority,
  streamErrors,
  verifySignature,
} from "./claw-authority.mjs";
import { accessEnv } from "./claw-observatory-access.mjs";

export const VIEW_MOUNT = "/reach/authority";
// The reviewer marks a view older than this as stale (authority.ts STALE_MS).
export const VIEW_STALE_MS = 10 * 60_000;
// The daemon sends a new event within about 1 s, and at its 60 s interval
// without the watch: a view behind by younger events is still on its way.
export const VIEW_SEND_MS = 90_000;
// A hub renews its certificate at day 60 of 90 (Follow-up 3 rule 7).
export const RENEW_NOTICE_MS = 30 * 24 * 3600_000;
export const HISTORY_LEDGER_MAX = 200;
export const MAX_HOURS = 720;
const ID_RE = /^[0-9a-f]{64}$/;

const ms = (iso) => Date.parse(iso);
const short = (id) => String(id ?? "").slice(0, 12);
const rank = (level) => LEVELS.indexOf(level);
const agentOf = (target) =>
  target.startsWith("agent:") ? target.slice(6) : target.startsWith("instance:") ? target.slice(9).split("@")[0] : null;
const targetsOf = (key, container) => ["fleet", `agent:${key}`, ...(container ? [`instance:${key}@${container}`] : [])];

// ── the reviewer's health (runs INSIDE a bot container; self-contained) ──────

/**
 * Counts from the last 24 h of the reviewer audit (its last 4 MB): calls and
 * verdicts, Layer 2 judge failures by cause (the judgeFailureCause set: a
 * judged call with no verdict), decider errors, restriction denies, and how
 * the newest row read the authority view. Nothing else leaves the bot.
 */
export function collectReviewerHealth(fs, path, home, nowArg) {
  const file = path.join(home, "logs", "reviewer", "reviewer-audit.jsonl");
  const now = Number(nowArg) || Date.now();
  const DAY = 86400000;
  const HOUR = 3600000;
  const MAX = 4 * 1024 * 1024;
  const out = {
    rows: 0,
    calls: 0,
    verdicts: {},
    l2: { judged: 0, failed: 0, failedHour: 0, causes: {}, lastFailure: null },
    decider: { rows: 0, errors: 0 },
    restriction: { enforced: 0, shadowWouldDeny: 0 },
    view: { at: null, fault: null, stale: false },
    lastAt: null,
  };
  let text = "";
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return { ...out, error: "the audit is not a regular file" };
    const start = Math.max(0, st.size - MAX);
    const fd = fs.openSync(file, "r");
    try {
      const b = Buffer.alloc(st.size - start);
      fs.readSync(fd, b, 0, b.length, start);
      text = b.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  } catch (e) {
    return { ...out, error: e && e.code === "ENOENT" ? "no audit yet" : "the audit does not read" };
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const t = Date.parse(r.ts);
    if (!(now - t <= DAY) || t > now + 60000) continue;
    out.rows++;
    if (!out.lastAt || r.ts > out.lastAt) out.lastAt = r.ts;
    if (r.phase === "decider_shadow") {
      out.decider.rows++;
      if (r.decError) out.decider.errors++;
      continue;
    }
    if (r.phase !== "before_tool_call") continue;
    out.calls++;
    const v = typeof r.verdict === "string" ? r.verdict : "none";
    out.verdicts[v] = (out.verdicts[v] || 0) + 1;
    if (r.l2Judged === true) {
      out.l2.judged++;
      if (Object.prototype.hasOwnProperty.call(r, "l2Verdict") && r.l2Verdict === null) {
        const cause = r.l2TimedOut ? "timeout" : r.l2EmptyReplies ? "empty reply" : r.l2Error ? "provider error" : "parse failure";
        out.l2.failed++;
        if (now - t <= HOUR) out.l2.failedHour++;
        out.l2.causes[cause] = (out.l2.causes[cause] || 0) + 1;
        if (!out.l2.lastFailure || r.ts > out.l2.lastFailure.at) out.l2.lastFailure = { at: r.ts, cause };
      }
    }
    if (r.restriction && r.restriction.changed) out.restriction.enforced++;
    if (r.restrictionShadow && r.restrictionShadow.wouldDeny) out.restriction.shadowWouldDeny++;
    if (!out.view.at || r.ts >= out.view.at) {
      out.view = { at: r.ts, fault: r.authorityFault ? String(r.authorityFault).slice(0, 200) : null, stale: r.authorityStale === true };
    }
  }
  return out;
}

/** ok, warn or bad, with the reasons. A judge failure in the last hour is red (Follow-up 3 rule 8). */
export function healthStatus(health) {
  if (!health) return { status: "unknown", notes: ["the bot is not running"] };
  if (health.error && !health.rows) return { status: "unknown", notes: [health.error] };
  const notes = [];
  let status = "ok";
  const worse = (s) => {
    if (s === "bad" || (s === "warn" && status === "ok")) status = s;
  };
  if (health.l2.failedHour) {
    worse("bad");
    notes.push(`${health.l2.failedHour} Layer 2 judge failure(s) in the last hour`);
  } else if (health.l2.failed) {
    worse("warn");
    notes.push(`${health.l2.failed} Layer 2 judge failure(s) in 24 h`);
  }
  if (health.view.fault) {
    worse("bad");
    notes.push(`the reviewer's last view read: ${health.view.fault}`);
  } else if (health.view.stale) {
    worse("warn");
    notes.push("the reviewer saw a stale view (older than 10 min)");
  }
  if (health.decider.errors) {
    worse("warn");
    notes.push(`${health.decider.errors} decider error(s) in 24 h`);
  }
  return { status, notes };
}

// ── host reads ───────────────────────────────────────────────────────────────

/** The daemon's two modes from its plist; the defaults when the plist says nothing. */
export function readDaemonModes(plistFile) {
  let text = "";
  try {
    text = fs.readFileSync(plistFile, "utf8");
  } catch {
    return { auto: "shadow", grants: "observe", plist: false };
  }
  const value = (name) => text.match(new RegExp(`<key>${name}</key>\\s*<string>([a-z]+)</string>`))?.[1] ?? null;
  const auto = value("OASIS_AUTHORITY_AUTO");
  const grants = value("OASIS_AUTHORITY_GRANTS");
  return { auto: auto === "enforce" ? "enforce" : "shadow", grants: grants === "require" ? "require" : "observe", plist: true };
}

/** One bot's view file as the Mac has it: { view } or { error }. */
export function readViewFile(viewDir, key) {
  const file = path.join(viewDir, key, VIEW_FILE);
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return { error: "not a regular file, or too large" };
    return { view: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (err) {
    return { error: err.code === "ENOENT" ? "missing" : "does not read" };
  }
}

/** The /reach/authority mount of one container: ro, rw, other-folder or missing. */
export function viewMount(inspect, key) {
  const m = (inspect?.Mounts ?? []).find((x) => String(x.Destination ?? "").replace(/\/+$/, "") === VIEW_MOUNT);
  if (!m) return { state: "missing", source: null };
  const source = String(m.Source ?? "").replace(/^\/host_mnt(?=\/)/, "");
  if (!source.replace(/\/+$/, "").endsWith(`/authority-view/${key}`)) return { state: "other-folder", source };
  return { state: m.RW === false ? "ro" : "rw", source };
}

// ── the page model ───────────────────────────────────────────────────────────

function signerOf(trust, key) {
  const root = trust.roots.get(key);
  if (root) return { key, role: "root", label: `Mike (${root.label} root)` };
  if (trust.hubs.has(key)) return { key, role: "hub", label: `hub ${key}` };
  return { key, role: "unknown", label: key ?? "unknown" };
}

/** One line per event. Ledger text names ids, states and bots only: a grant's topic is bot-written. */
export function eventSummary(e) {
  const b = e.body ?? {};
  switch (e.kind) {
    case "root.genesis":
      return `genesis: root ${b.roots?.[0]?.label ?? "?"}; hub for ${(b.hub?.agents ?? []).join(", ")} until ${b.hub?.expiresAt ?? "?"}`;
    case "root.add":
      return `root added (${b.root?.label ?? "?"})`;
    case "root.remove":
      return `root removed: ${b.key}`;
    case "hub.cert":
      return `hub certified for ${(b.hub?.agents ?? []).join(", ")} until ${b.hub?.expiresAt ?? "?"}`;
    case "hub.revoke":
      return `hub revoked: ${b.key}`;
    case "key.void":
      return `key ${b.key} void from ${b.since}`;
    case "restriction.add":
      return `${b.target} ${b.level} (${b.trigger})${b.expiresAt ? ` until ${b.expiresAt}` : ""}${b.evidence ? `, evidence ${short(b.evidence)}` : ""}: ${String(b.reason ?? "").slice(0, 200)}`;
    case "restriction.lift":
      return `lift ${(b.ids ?? []).map(short).join(", ")}`;
    case "grant.state": {
      const r = b.record ?? {};
      return `${b.id} ${r.status ?? "?"} (${r.kind === "directive" ? "directive" : "grant"}, ${r.requester ?? "?"} → ${(r.grantees ?? []).join(", ")})${b.anomaly ? `; NOT LEGAL: ${b.anomaly}` : ""}`;
    }
    case "grant.removed":
      return `${b.id} removed from the ledger file${b.anomaly ? `; NOT LEGAL: ${b.anomaly}` : ""}`;
    default:
      return e.kind;
  }
}

/** The signed history, newest first: every control and restriction event, the newest ledger events. */
export function authorityHistory(auth, { ledgerMax = HISTORY_LEDGER_MAX } = {}) {
  const pick = (name) => (name === "ledger" ? auth.streams.ledger.events.slice(-ledgerMax) : auth.streams[name].events);
  return STREAMS.flatMap((name) =>
    pick(name).map((e) => ({
      stream: name,
      seq: e.seq,
      at: e.at,
      kind: e.kind,
      scope: e.scope,
      id: e.id,
      signer: signerOf(auth.trust, e.signer?.key),
      cosigners: Array.isArray(e.cosigs) ? e.cosigs.length : 0,
      summary: eventSummary(e),
    })),
  ).sort((a, b) => ms(b.at) - ms(a.at) || b.seq - a.seq);
}

/** The view state of one bot: what its reviewer can read, against the hub's log. */
export function viewState({ key, container, running }, read, auth, nowMs) {
  if (read.error) return { state: read.error === "missing" ? "missing" : "bad", text: `the view file is ${read.error}`, at: null };
  const v = read.view;
  const hub = auth.trust.hubs.get(v?.hub);
  const { sig, ...signed } = v ?? {};
  let sigOk = false;
  try {
    sigOk = !!hub && verifySignature(hub, Buffer.from(canonical(signed), "utf8"), sig);
  } catch {
    sigOk = false;
  }
  const at = typeof v?.at === "string" ? v.at : null;
  if (!sigOk) return { state: "bad", text: "the view has no valid hub signature", at };
  if (v.bot !== key) return { state: "bad", text: `the view is for ${v.bot}`, at };
  const heads = { restrictions: auth.streams.restrictions.events.at(-1)?.seq ?? -1, ledger: auth.streams.ledger.events.at(-1)?.seq ?? -1 };
  const seqs = { restrictions: v.restrictions?.seq ?? -1, ledger: v.ledger?.seq ?? -1 };
  const base = { at, seqs, heads, grantMode: v.ledger?.grantMode ?? null };
  if (running && container && v.container !== container) return { ...base, state: "behind", text: `the view names ${v.container ?? "no container"}, not ${container}` };
  if (seqs.restrictions < heads.restrictions || seqs.ledger < heads.ledger) {
    const missing = ["restrictions", "ledger"].map((n) => auth.streams[n].events[seqs[n] + 1]).filter(Boolean);
    const oldest = Math.min(...missing.map((e) => ms(e.at)));
    const text = `the view has restrictions ${seqs.restrictions} and ledger ${seqs.ledger}; the log has ${heads.restrictions} and ${heads.ledger}`;
    if (nowMs - oldest < VIEW_SEND_MS) return { ...base, state: "sending", text: `${text}: the daemon sends the new events` };
    return { ...base, state: "behind", text };
  }
  if (nowMs - ms(at) > VIEW_STALE_MS) return { ...base, state: "stale", text: `the view is from ${at}: is the authority daemon running?` };
  return { ...base, state: "current", text: "the view matches the log" };
}

function grantCounts(auth, key) {
  const out = { grants: [], directives: [], notLegal: [] };
  for (const [id, s] of auth.ledger) {
    if (s.removed || !Array.isArray(s.record.grantees) || !s.record.grantees.includes(key)) continue;
    if (!s.legal) out.notLegal.push(id);
    if (s.record.status !== "active") continue;
    (s.record.kind === "directive" ? out.directives : out.grants).push(id);
  }
  return out;
}

/**
 * Everything the Authority page shows. `bots` come from the observatory's
 * fleet discovery (excluded deployments already removed); `views`, `health`
 * and `inspects` are keyed by bot key.
 */
export function describeAuthority({ auth, bots, views = {}, health = {}, inspects = {}, modes = { auto: "shadow", grants: "observe" }, nowMs = Date.now() }) {
  const ev = evaluateRestrictions(auth.streams.restrictions.events, auth.trust, nowMs);
  const modeOf = (r) => (r.byRoot || modes.auto === "enforce" ? "enforce" : "shadow");
  const active = ev.active.map((r) => ({ ...r, mode: modeOf(r) }));
  // A "keep" is a root restriction whose evidence is the id it keeps.
  const keptBy = new Map();
  for (const r of active) if (r.byRoot && ID_RE.test(String(r.evidence))) keptBy.set(r.evidence, r.id);
  const hubs = [...auth.trust.hubs].map(([key, h]) => {
    const revoked = auth.trust.revoked.has(key);
    const expMs = ms(h.expiresAt);
    return { key, agents: h.agents, certifiedAt: h.certifiedAt, expiresAt: h.expiresAt, revoked, valid: !revoked && expMs > nowMs, renewDue: !revoked && expMs - nowMs <= RENEW_NOTICE_MS };
  });
  const instances = bots.map((bot) => {
    const targets = new Set(targetsOf(bot.key, bot.container));
    const items = active.filter((r) => targets.has(r.target));
    const strongest = (list) => list.reduce((lvl, r) => (!lvl || rank(r.level) > rank(lvl) ? r.level : lvl), null);
    const enforced = strongest(items.filter((r) => r.mode === "enforce"));
    const shadow = strongest(items.filter((r) => r.mode === "shadow"));
    const read = views[bot.key] ?? { error: "missing" };
    const view = viewState(bot, read, auth, nowMs);
    const signsViews = read.view?.hub ?? null;
    // Only the ACCESS_ENV names: the rest of a bot's environment holds tokens.
    const env = accessEnv(inspects[bot.key]);
    const h = bot.running ? health[bot.key] ?? null : null;
    return {
      key: bot.key,
      container: bot.container,
      running: !!bot.running,
      state: bot.state ?? null,
      level: { enforced, shadow: shadow && (!enforced || rank(shadow) > rank(enforced)) ? shadow : null },
      restrictions: items.map((r) => r.id),
      reviewer: {
        mode: env.OASIS_REVIEWER_MODE || "off",
        l2: env.OASIS_REVIEWER_L2 || "off",
        decider: env.OASIS_REVIEWER_DECIDER || "off",
        health: h,
        ...(bot.running ? healthStatus(h) : { status: "unknown", notes: [`${bot.container} is ${bot.state ?? "not running"}`] }),
      },
      homeHubs: hubs.filter((x) => x.valid && (x.agents.includes("*") || x.agents.includes(bot.key))).map((x) => ({ key: x.key, expiresAt: x.expiresAt, signsViews: x.key === signsViews })),
      grants: grantCounts(auth, bot.key),
      view: { ...view, mount: viewMount(inspects[bot.key], bot.key) },
    };
  });

  const cards = [];
  const card = (c) => cards.push(c);
  if (!auth.pin) card({ kind: "log", tone: "bad", title: "No authority on this Mac", text: "The state folder has no pinned root. Run make authority-init (one Touch ID)." });
  for (const err of streamErrors(auth)) {
    card({ kind: "log", tone: "bad", title: "The log does not verify", text: `${err}. The daemon writes no view, so each bot keeps its last good one.` });
  }
  for (const r of ev.expiring) {
    if (keptBy.has(r.id)) continue;
    card({ kind: "expiring", tone: "warn", title: `Keep or let expire: ${r.target} ${r.level}`, text: `${r.reason} (${r.trigger}). It ends at ${r.expiresAt}.`, id: r.id, target: r.target, expiresAt: r.expiresAt });
  }
  for (const s of ev.storms) {
    card({
      kind: "storm",
      tone: "bad",
      title: `Storm: ${s.held} automatic restriction(s) held`,
      text: `The issuer ${s.issuer} went over the rate budget (2 agents in 1 hour) from ${s.from} to ${s.to}. The held restrictions are not in force. If the key is stolen: node scripts/claw-authority.mjs void-key ${s.issuer} --since ${s.from}`,
      issuer: s.issuer,
    });
  }
  for (const [id, s] of auth.ledger) {
    if (!s.legal) card({ kind: "anomaly", tone: "bad", title: `Ledger record not legal: ${id}`, text: `${s.anomaly}. The mirror keeps it suspect; with grants=require the reviewer does not use it.`, grant: id });
  }
  for (const x of hubs) {
    if (x.renewDue && x.valid) card({ kind: "hub", tone: "warn", title: `Hub certificate ends ${x.expiresAt}`, text: `Renew it before the end: node scripts/claw-authority.mjs renew-hub (one Touch ID). An expired hub writes no view.`, hub: x.key });
  }
  for (const i of instances) {
    if (!i.running) continue;
    if (i.view.mount.state !== "ro") {
      const why = { missing: "the container has no /reach/authority mount", rw: "/reach/authority is read-write", "other-folder": `/reach/authority comes from ${i.view.mount.source}` }[i.view.mount.state];
      card({ kind: "view", tone: "bad", title: `${i.key}: the reviewer cannot read its own view`, text: `${why}. Add the read-only mount to the bot's compose file and recreate the bot.`, bot: i.key });
    } else if (i.view.state !== "current" && i.view.state !== "sending") {
      card({ kind: "view", tone: i.view.state === "bad" ? "bad" : "warn", title: `${i.key}: view ${i.view.state}`, text: i.view.text, bot: i.key });
    }
    if (i.reviewer.status === "bad") card({ kind: "reviewer", tone: "bad", title: `${i.key}: reviewer health`, text: `${i.reviewer.notes.join("; ")}. A reviewer failure blocks only the call; it never restricts the bot.`, bot: i.key });
  }

  return {
    at: new Date(nowMs).toISOString(),
    dir: auth.dir,
    pin: auth.pin,
    ok: auth.ok,
    errors: streamErrors(auth),
    modes,
    levels: LEVELS,
    roots: [...auth.trust.roots].map(([key, r]) => ({ key, label: r.label, addedAt: r.addedAt })),
    hubs,
    streams: Object.fromEntries(STREAMS.map((n) => [n, { events: auth.streams[n].events.length, head: auth.streams[n].head }])),
    restrictions: {
      active: active.map((r) => ({ ...r, reason: String(r.reason).slice(0, 500), keptBy: keptBy.get(r.id) ?? null })),
      held: ev.held,
      storms: ev.storms,
    },
    instances,
    cards,
    history: authorityHistory(auth),
  };
}

/** The page model from the files on this Mac. `inspectFor(container)` is the observatory's cache. */
export function authorityPage({ dir, viewDir, plist, bots, inspectFor = () => null, health = {}, nowMs = Date.now() }) {
  const auth = loadAuthority(dir);
  const views = {};
  const inspects = {};
  for (const b of bots) {
    views[b.key] = readViewFile(viewDir, b.key);
    inspects[b.key] = inspectFor(b.container);
  }
  return describeAuthority({ auth, bots, views, health, inspects, modes: readDaemonModes(plist), nowMs });
}

// ── writes: one root signature each ──────────────────────────────────────────

/**
 * Check one request and build the event it asks for. Returns { entry }
 * or { status, error }. `botKeys` are the bots of the fleet: a typo must not
 * restrict no bot while Mike thinks it is restricted.
 */
export function planAction(op, body, { auth, botKeys, nowMs = Date.now() }) {
  const bad = (error, status = 400) => ({ status, error });
  if (!auth.pin) return bad("this Mac has no authority yet: run make authority-init", 409);
  if (!auth.ok) return bad(`the log does not verify: ${streamErrors(auth).join("; ")}`, 409);
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("the body is a JSON object");
  const ev = evaluateRestrictions(auth.streams.restrictions.events, auth.trust, nowMs);
  if (op === "restrict") {
    const target = String(body.target ?? "");
    if (!TARGET_RE.test(target)) return bad("the target is fleet, agent:<bot> or instance:<bot>@<container>");
    const agent = agentOf(target);
    if (agent && !botKeys.includes(agent)) return bad(`no bot "${agent}" in the fleet`);
    if (!LEVELS.includes(body.level)) return bad(`the level is one of ${LEVELS.join(", ")}`);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason || reason.length > 500) return bad("give a reason (500 characters at most)");
    let expiresAt;
    if (body.hours !== undefined && body.hours !== null) {
      if (!Number.isInteger(body.hours) || body.hours < 1 || body.hours > MAX_HOURS) return bad(`hours is a whole number from 1 to ${MAX_HOURS}, or empty (until Mike lifts it)`);
      expiresAt = new Date(nowMs + body.hours * 3600_000).toISOString();
    }
    return { entry: { kind: "restriction.add", scope: target, body: { target, level: body.level, trigger: "mike", reason, ...(expiresAt ? { expiresAt } : {}) } } };
  }
  if (op === "lift") {
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
    if (!ids.length || ids.length > 20 || !ids.every((id) => ID_RE.test(id))) return bad("ids is a list of 1 to 20 restriction ids");
    const inForce = new Set(ev.active.map((r) => r.id));
    const missing = ids.filter((id) => !inForce.has(id));
    if (missing.length) return bad(`not in force: ${missing.map(short).join(", ")}`, 409);
    return { entry: { kind: "restriction.lift", scope: "fleet", body: { ids } } };
  }
  if (op === "keep") {
    const id = String(body.id ?? "");
    const r = ev.active.find((x) => x.id === id);
    if (!r) return bad("that restriction is not in force", 409);
    if (!r.expiresAt) return bad("that restriction has no end: it stays until you lift it", 409);
    if (ev.active.some((x) => x.byRoot && x.evidence === r.id)) return bad("you kept that restriction already", 409);
    const kept = { target: r.target, level: r.level, trigger: "mike", reason: `kept by Mike: ${r.reason}`.slice(0, 500), evidence: r.id };
    return { entry: { kind: "restriction.add", scope: r.target, body: kept } };
  }
  return bad(`unknown action ${op}`, 404);
}

/** Mike's root key in the Secure Enclave, as `claw-authority` uses it. */
export async function rootSignerFor(dir) {
  const tool = process.env.OASIS_ROOT_KEY_TOOL || path.join(dir, "bin", "oasis-root-key");
  const keyFile = path.join(dir, "root.se");
  if (!fs.existsSync(keyFile) || !fs.existsSync(tool)) {
    throw Object.assign(new Error("no root key tool or key on this Mac: run make authority-init"), { status: 409 });
  }
  return enclaveSigner(tool, keyFile);
}

let signing = false;

/**
 * Plan, sign (Touch ID) and append one event. One request at a time: a second
 * click while Touch ID waits gets 409, not a second prompt. appendEvent checks
 * the event again under the log lock, against the same rules as verify.
 */
export async function runAction(op, body, { dir, botKeys, signer, now = Date.now }) {
  if (signing) return { status: 409, error: "a Touch ID request is already open on the Mac" };
  signing = true;
  try {
    const plan = planAction(op, body, { auth: loadAuthority(dir), botKeys, nowMs: now() });
    if (plan.error) return plan;
    const e = await appendEvent(dir, "restrictions", plan.entry, await signer(), { now });
    return { ok: true, op, event: { id: e.id, seq: e.seq, at: e.at, kind: e.kind, scope: e.scope }, summary: eventSummary(e) };
  } catch (err) {
    return { status: err.status ?? 502, error: err.message };
  } finally {
    signing = false;
  }
}
