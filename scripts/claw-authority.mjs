#!/usr/bin/env node
// ── claw-authority: the authority hub core (Mike, 2026-11-02) ────────────────
// Step 3 of the identity plan. The Mac is the first authority hub. Every
// authority fact is an event in a signed, hash-chained, append-only stream in
// the observatory state folder. Design: the shared notes "feature-exploration
// 2026-10-31", sections 3.3 (event log), Follow-up 2 (reviewer authority,
// keys) and Follow-up 3 (cascade limits, accepted by Mike on 2026-11-02).
//
// KEYS
//   root  Mike's key in this Mac's Secure Enclave (scripts/authority/
//         oasis-root-key.swift): P-256, Touch ID or the Mac password for each
//         signature. A later iPhone root and an offline recovery root join
//         with `root.add`. A change to the root set needs 2 roots once 2 exist.
//   hub   this Mac's Ed25519 key (hub.ed25519.pem, 0600). The root certifies
//         it for named agents for 90 days at most (`hub.cert`). It signs
//         the automatic events; it can never loosen anything.
//
// STREAMS (streams/<name>.jsonl, one JSON event per line)
//   control       root.genesis, root.add, root.remove, hub.cert, hub.revoke,
//                 key.void: who may sign what. Only roots sign here.
//   restrictions  restriction.add, restriction.lift.
// Each event: { v, stream, seq, prev, hlc, at, kind, scope, body, signer }
// plus id = sha256(canonical form) and sig over the same bytes. prev is the
// id of the event before it, so a changed, dropped or reordered line breaks
// the chain. The one consensus step is the append lock plus the head check.
//
// RESTRICTIONS (Follow-up 3, "tighten in your own scope, loosen once")
//   - Levels, mildest first: fail-closed, read-only, chat-only, stopped.
//   - A root restricts any scope at any level ("mike"); only a root lifts.
//   - A hub restricts only an agent or instance of its certificate, never
//     the fleet, never below chat-only, and only with a trigger and the
//     hash of the event that caused it. A count-rule or X-model restriction
//     expires after 24 h at most; a hard-rule one stays until Mike lifts it.
//   - Rate budget: one issuer restricts at most 2 agents in 1 hour. More is
//     held (not in force) and reported as a storm. A budget never loosens.
//   - No rule turns one restriction into another (no cascade).
//   - Merge: an observed-remove set. A lift names the add ids it removes; a
//     key.void removes a key's adds from a time on.
//
// TRUST: the genesis root is pinned out of band (root.pin; `init` prints the
// fingerprint). There is no trust on first use: without a pin nothing
// verifies. Nothing enforces these restrictions yet; the reviewer reads them
// in a later step. Nothing here talks to the network.
//
// LIMIT: the folder (~/Library/Application Support/oasis-x/observatory/
// authority, 0700) is mounted into no bot container (checked 2026-11-02:
// only the port proxy mounts one other file of the state folder), so a bot
// can neither read the hub key nor reach the Secure Enclave. Malware that
// runs as Mike on the Mac can do both, and can show its own Touch ID text:
// the root key guards against the bots, not against a compromised Mac login.
//
// COMMANDS
//   init [--tool PATH]                  make the hub key and the root key,
//                                       sign the genesis (one Touch ID)
//   status [--json]                     keys, streams, restrictions in force
//   verify                              check every stream; exit 1 on a fault
//   log <stream> [--limit N]
//   restrict <target> --level L --reason TEXT [--hours H]   (Touch ID)
//   freeze <target>                     restrict to chat-only (Touch ID)
//   lift <id>...                        (Touch ID)
//   void-key <key> --since ISO          (Touch ID)
//   renew-hub [--agents a,b]            a new 90-day hub certificate (Touch ID)
// A target is `fleet`, `agent:<bot>` or `instance:<bot>@<container>`.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_DIR =
  process.env.OASIS_OBSERVATORY_STATE_DIR || path.join(os.homedir(), "Library", "Application Support", "oasis-x", "observatory");
export const DEFAULT_DIR = path.join(STATE_DIR, "authority");

export const STREAMS = ["control", "restrictions"];
export const LEVELS = ["fail-closed", "read-only", "chat-only", "stopped"];
export const AUTO_FLOOR = "chat-only";
export const HUB_TRIGGERS = ["hard-rule", "canary", "never-downgrade", "count-rule", "x-model"];
export const TTL_TRIGGERS = ["count-rule", "x-model"];
export const TTL_MS = 24 * 3600_000;
export const HUB_CERT_MAX_MS = 90 * 24 * 3600_000;
export const BUDGET = { agents: 2, windowMs: 3600_000 };
export const COUNT_RULE = { denials: 5, windowMs: 10 * 60_000 };
export const EXPIRY_NOTICE_MS = 2 * 3600_000;
const LOCK_STALE_MS = 10 * 60_000;
const TARGET_RE = /^(?:fleet|agent:[a-z0-9-]{1,40}|instance:[a-z0-9-]{1,40}@[a-z0-9][a-z0-9_.-]{0,80})$/;
const ID_RE = /^[0-9a-f]{64}$/;

// ── canonical form and keys ──────────────────────────────────────────────────

/** Sorted keys, no spaces, safe integers only: one byte string per value. */
export function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("an authority event holds integers only");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  throw new Error(`an authority event cannot hold a ${typeof value}`);
}

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

function publicKeyObject(pub) {
  return crypto.createPublicKey({ key: Buffer.from(pub.public, "base64"), format: "der", type: "spki" });
}

/** "ed25519:<16 hex>" or "p256:<16 hex>" from the SPKI DER (as the Swift tool). */
export function fingerprint(pub) {
  return `${pub.alg}:${sha256(Buffer.from(pub.public, "base64")).slice(0, 16)}`;
}

function keyMatchesAlg(key, alg) {
  if (alg === "ed25519") return key.asymmetricKeyType === "ed25519";
  if (alg === "p256") return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  return false;
}

export function verifySignature(pub, bytes, sigB64) {
  try {
    const key = publicKeyObject(pub);
    if (!keyMatchesAlg(key, pub.alg)) return false;
    const sig = Buffer.from(String(sigB64), "base64");
    return pub.alg === "ed25519" ? crypto.verify(null, bytes, key, sig) : crypto.verify("sha256", bytes, { key, dsaEncoding: "der" }, sig);
  } catch {
    return false;
  }
}

/** A signer from a private KeyObject (the hub key; software roots in tests). */
export function keySigner(privateKey) {
  const alg = privateKey.asymmetricKeyType === "ed25519" ? "ed25519" : "p256";
  const pub = { alg, public: crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64") };
  if (!keyMatchesAlg(publicKeyObject(pub), alg)) throw new Error("only Ed25519 and P-256 keys can sign authority events");
  return {
    ...pub,
    key: fingerprint(pub),
    sign: async (bytes) =>
      (alg === "ed25519" ? crypto.sign(null, bytes, privateKey) : crypto.sign("sha256", bytes, { key: privateKey, dsaEncoding: "der" })).toString("base64"),
  };
}

function runTool(tool, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `${path.basename(tool)} exited ${code}`));
    });
    child.stdin.end(input ?? "");
  });
}

/** The Secure Enclave root through oasis-root-key. Each sign() asks for Touch ID. */
export async function enclaveSigner(tool, keyFile) {
  const pub = JSON.parse(await runTool(tool, ["public", keyFile]));
  return {
    alg: pub.alg,
    public: pub.public,
    key: fingerprint(pub),
    sign: async (bytes) => {
      const out = JSON.parse(await runTool(tool, ["sign", keyFile], bytes));
      if (out.id !== sha256(bytes) || out.key !== fingerprint(pub)) throw new Error("the root tool signed something else");
      return out.sig;
    },
  };
}

// ── events ───────────────────────────────────────────────────────────────────

const UNSIGNED_FIELDS = ["v", "stream", "seq", "prev", "hlc", "at", "kind", "scope", "body", "signer"];

export function unsignedOf(event) {
  return Object.fromEntries(UNSIGNED_FIELDS.map((k) => [k, event[k]]));
}

export function signingBytes(event) {
  return Buffer.from(canonical(unsignedOf(event)), "utf8");
}

export function nextHlc(prev, nowMs) {
  if (!prev) return [nowMs, 0];
  return nowMs > prev[0] ? [nowMs, 0] : [prev[0], prev[1] + 1];
}

const hlcAfter = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
const ms = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
};

// ── trust (the control stream) and authorization ─────────────────────────────

function emptyTrust(pin) {
  return { pin, roots: new Map(), hubs: new Map(), voids: [], revoked: new Map() };
}

/** Who signed `event`, and every signature that counts (main + cosigs). */
function signersOf(trust, event, pool) {
  const bytes = signingBytes(event);
  const sigs = [{ key: event.signer?.key, sig: event.sig }, ...(Array.isArray(event.cosigs) ? event.cosigs : [])];
  const ok = new Set();
  for (const s of sigs) {
    const pub = pool.get(s.key);
    if (pub && verifySignature(pub, bytes, s.sig)) ok.add(s.key);
  }
  return ok;
}

function rootPool(trust) {
  return new Map([...trust.roots].map(([k, v]) => [k, v]));
}

function hubValidAt(trust, keyId, atMs) {
  const hub = trust.hubs.get(keyId);
  if (!hub) return null;
  if (atMs > ms(hub.expiresAt)) return null;
  const revokedAt = trust.revoked.get(keyId);
  if (revokedAt !== undefined && atMs >= revokedAt) return null;
  return hub;
}

function checkRootEntry(r) {
  if (!r || r.alg !== "p256" || typeof r.public !== "string") return "a root must be a P-256 public key";
  try {
    if (!keyMatchesAlg(publicKeyObject(r), "p256")) return "a root must be a P-256 public key";
  } catch {
    return "a root public key does not parse";
  }
  return null;
}

function checkHubEntry(h, atMs) {
  if (!h || h.alg !== "ed25519" || typeof h.public !== "string") return "a hub key must be Ed25519";
  try {
    if (!keyMatchesAlg(publicKeyObject(h), "ed25519")) return "a hub key must be Ed25519";
  } catch {
    return "a hub public key does not parse";
  }
  if (!Array.isArray(h.agents) || !h.agents.length || !h.agents.every((a) => a === "*" || /^[a-z0-9-]{1,40}$/.test(a))) {
    return "a hub certificate names its agents (or *)";
  }
  const exp = ms(h.expiresAt);
  if (!(exp > atMs) || exp - atMs > HUB_CERT_MAX_MS) return "a hub certificate lasts 90 days at most";
  return null;
}

/** Apply one control event to `trust`; return an error text or null. */
export function applyControl(trust, event) {
  const atMs = ms(event.at);
  const b = event.body ?? {};
  if (event.seq === 0) {
    if (event.kind !== "root.genesis") return "the control stream starts with root.genesis";
    const roots = Array.isArray(b.roots) ? b.roots : [];
    if (roots.length !== 1) return "the genesis names exactly one root";
    const bad = checkRootEntry(roots[0]) ?? checkHubEntry(b.hub, atMs);
    if (bad) return bad;
    const rootKey = fingerprint(roots[0]);
    if (!trust.pin) return "no pinned root: refusing to trust the genesis (no trust on first use)";
    if (rootKey !== trust.pin) return `the genesis root ${rootKey} is not the pinned root ${trust.pin}`;
    if (!signersOf(trust, event, new Map([[rootKey, roots[0]]])).has(rootKey)) return "the genesis is not signed by its root";
    trust.roots.set(rootKey, { ...roots[0], label: String(roots[0].label ?? "root"), addedAt: event.at });
    trust.hubs.set(fingerprint(b.hub), { ...b.hub, certifiedAt: event.at });
    return null;
  }
  const signed = signersOf(trust, event, rootPool(trust));
  if (!signed.has(event.signer?.key)) return "a control event needs a root signature";
  switch (event.kind) {
    case "root.add":
    case "root.remove": {
      const need = Math.min(2, trust.roots.size);
      if (signed.size < need) return `a root set change needs ${need} root signatures`;
      if (event.kind === "root.add") {
        const bad = checkRootEntry(b.root);
        if (bad) return bad;
        trust.roots.set(fingerprint(b.root), { ...b.root, label: String(b.root.label ?? "root"), addedAt: event.at });
      } else {
        if (!trust.roots.has(b.key)) return "root.remove names an unknown root";
        if (trust.roots.size === 1) return "the last root cannot be removed";
        trust.roots.delete(b.key);
      }
      return null;
    }
    case "hub.cert": {
      const bad = checkHubEntry(b.hub, atMs);
      if (bad) return bad;
      const key = fingerprint(b.hub);
      if (trust.revoked.has(key)) return "a revoked hub key cannot be certified again";
      trust.hubs.set(key, { ...b.hub, certifiedAt: event.at });
      return null;
    }
    case "hub.revoke":
      if (!trust.hubs.has(b.key)) return "hub.revoke names an unknown hub";
      trust.revoked.set(b.key, atMs);
      return null;
    case "key.void": {
      const since = ms(b.since);
      if (typeof b.key !== "string" || !Number.isFinite(since)) return "key.void needs a key and a since time";
      trust.voids.push({ key: b.key, since });
      if (trust.hubs.has(b.key) && !trust.revoked.has(b.key)) trust.revoked.set(b.key, Math.min(since, atMs));
      return null;
    }
    default:
      return `unknown control kind ${event.kind}`;
  }
}

const agentOf = (target) => (target.startsWith("agent:") ? target.slice(6) : target.startsWith("instance:") ? target.slice(9).split("@")[0] : null);

/** Is the signer allowed to append this restrictions event? Error text or null. */
export function authorizeRestriction(trust, event) {
  const atMs = ms(event.at);
  const b = event.body ?? {};
  const signerKey = event.signer?.key;
  const isRoot = trust.roots.has(signerKey);
  const hub = isRoot ? null : hubValidAt(trust, signerKey, atMs);
  const pool = new Map(isRoot ? [[signerKey, trust.roots.get(signerKey)]] : hub ? [[signerKey, hub]] : []);
  if (!signersOf(trust, event, pool).has(signerKey)) return isRoot || hub ? "bad signature" : "the signer is not a root or a valid hub";
  if (event.kind === "restriction.lift") {
    if (!isRoot) return "only a root lifts a restriction";
    if (!Array.isArray(b.ids) || !b.ids.length || !b.ids.every((id) => ID_RE.test(id))) return "restriction.lift names the add ids";
    return null;
  }
  if (event.kind !== "restriction.add") return `unknown restrictions kind ${event.kind}`;
  if (!TARGET_RE.test(String(b.target)) || event.scope !== b.target) return "a restriction names its target (fleet, agent:<bot> or instance:<bot>@<container>)";
  if (!LEVELS.includes(b.level)) return `the level must be one of ${LEVELS.join(", ")}`;
  if (typeof b.reason !== "string" || !b.reason.trim() || b.reason.length > 500) return "a restriction gives a reason (500 characters at most)";
  if (b.expiresAt !== undefined && !(ms(b.expiresAt) > atMs)) return "expiresAt must be after the event";
  if (isRoot) return b.trigger === "mike" ? null : "a root restriction has the trigger mike";
  // A hub: its own scope, the floor, a trigger with evidence, the TTL.
  if (b.target === "fleet") return "only a root restricts the fleet";
  const agent = agentOf(b.target);
  if (!hub.agents.includes("*") && !hub.agents.includes(agent)) return `this hub is not certified for ${agent}`;
  if (LEVELS.indexOf(b.level) > LEVELS.indexOf(AUTO_FLOOR)) return `an automatic restriction stops at ${AUTO_FLOOR}`;
  if (!HUB_TRIGGERS.includes(b.trigger)) return `an automatic restriction has a trigger: ${HUB_TRIGGERS.join(", ")}`;
  if (!ID_RE.test(String(b.evidence))) return "an automatic restriction names the hash of the event that caused it";
  if (TTL_TRIGGERS.includes(b.trigger) && !(ms(b.expiresAt) - atMs <= TTL_MS)) return `a ${b.trigger} restriction expires within 24 hours`;
  return null;
}

// ── reading and verifying streams ────────────────────────────────────────────

/** Chain checks for one stream's parsed lines; `check(event)` adds the rules. */
export function verifyChain(name, lines, check) {
  const events = [];
  const errors = [];
  let prev = null;
  for (const [i, line] of lines.entries()) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      errors.push(`line ${i + 1}: not JSON`);
      break;
    }
    const where = `line ${i + 1}`;
    let fault = null;
    if (e.v !== 1 || e.stream !== name) fault = "wrong version or stream";
    else if (e.seq !== i) fault = `seq ${e.seq}, expected ${i}`;
    else if (e.prev !== (prev ? prev.id : null)) fault = "prev does not name the event before it";
    else if (!Array.isArray(e.hlc) || e.hlc.length !== 2 || !e.hlc.every(Number.isSafeInteger) || (prev && !hlcAfter(e.hlc, prev.hlc))) fault = "clock goes backward";
    else if (!Number.isFinite(ms(e.at))) fault = "bad time";
    else {
      try {
        if (e.id !== sha256(signingBytes(e))) fault = "id does not match the content";
      } catch (err) {
        fault = err.message;
      }
    }
    if (!fault) fault = check(e);
    if (fault) {
      errors.push(`${where} (${e.kind ?? "?"}): ${fault}`);
      break; // nothing after a broken link can be trusted
    }
    events.push(e);
    prev = e;
  }
  return { events, errors, head: prev ? prev.id : null };
}

function readLines(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return text.split("\n").filter((l) => l.trim());
}

export function readPin(dir) {
  try {
    const pin = fs.readFileSync(path.join(dir, "root.pin"), "utf8").trim();
    return /^p256:[0-9a-f]{16}$/.test(pin) ? pin : null;
  } catch {
    return null;
  }
}

export function loadAuthority(dir, { pin = readPin(dir) } = {}) {
  const trust = emptyTrust(pin);
  const control = verifyChain("control", readLines(path.join(dir, "streams", "control.jsonl")), (e) => applyControl(trust, e));
  const restrictions = verifyChain("restrictions", readLines(path.join(dir, "streams", "restrictions.jsonl")), (e) =>
    authorizeRestriction(trust, e),
  );
  return { dir, pin, trust, streams: { control, restrictions }, ok: !control.errors.length && !restrictions.errors.length };
}

// ── restrictions in force ────────────────────────────────────────────────────

/** The restrictions in force at `nowMs`, from verified restriction events. */
export function evaluateRestrictions(events, trust, nowMs) {
  const lifted = new Set(events.filter((e) => e.kind === "restriction.lift").flatMap((e) => e.body.ids));
  const accepted = new Map(); // issuer -> [{atMs, agent}]
  const active = [];
  const held = [];
  const storms = new Map();
  for (const e of events) {
    if (e.kind !== "restriction.add") continue;
    const atMs = ms(e.at);
    const issuer = e.signer.key;
    const isRoot = trust.roots.has(issuer);
    if (!isRoot) {
      const agent = agentOf(e.body.target);
      const recent = (accepted.get(issuer) ?? []).filter((a) => atMs - a.atMs < BUDGET.windowMs);
      const agents = new Set(recent.map((a) => a.agent));
      if (!agents.has(agent) && agents.size >= BUDGET.agents) {
        held.push({ id: e.id, target: e.body.target, issuer, at: e.at, reason: "over the rate budget (2 agents in 1 hour)" });
        const storm = storms.get(issuer) ?? { issuer, from: e.at, to: e.at, held: 0 };
        storm.to = e.at;
        storm.held += 1;
        storms.set(issuer, storm);
        continue;
      }
      recent.push({ atMs, agent });
      accepted.set(issuer, recent);
    }
    if (lifted.has(e.id)) continue;
    if (trust.voids.some((v) => v.key === issuer && atMs >= v.since)) continue;
    const expMs = e.body.expiresAt ? ms(e.body.expiresAt) : null;
    if (expMs !== null && expMs <= nowMs) continue;
    active.push({
      id: e.id,
      target: e.body.target,
      level: e.body.level,
      trigger: e.body.trigger,
      reason: e.body.reason,
      evidence: e.body.evidence ?? null,
      issuer,
      byRoot: isRoot,
      at: e.at,
      expiresAt: e.body.expiresAt ?? null,
    });
  }
  const byTarget = {};
  for (const r of active) {
    const cur = byTarget[r.target];
    if (!cur || LEVELS.indexOf(r.level) > LEVELS.indexOf(cur.level)) byTarget[r.target] = { level: r.level, ids: [r.id] };
    else if (cur.level === r.level) cur.ids.push(r.id);
  }
  const expiring = active.filter((r) => r.expiresAt && ms(r.expiresAt) - nowMs <= EXPIRY_NOTICE_MS);
  return { active, held, storms: [...storms.values()], expiring, byTarget };
}

/** The strongest level in force for one instance of one agent, or null. */
export function effectiveLevel(evaluation, agent, instance) {
  const targets = ["fleet", `agent:${agent}`, ...(instance ? [`instance:${agent}@${instance}`] : [])];
  let level = null;
  for (const t of targets) {
    const l = evaluation.byTarget[t]?.level;
    if (l && (!level || LEVELS.indexOf(l) > LEVELS.indexOf(level))) level = l;
  }
  return level;
}

/** The count rule: 5 denials in 10 minutes on one instance. Pure; the reviewer
 *  audit feeds it in a later step. denials: [{ id, at, agent, instance }]. */
export function countRuleHits(denials, nowMs, rule = COUNT_RULE) {
  const byInstance = new Map();
  for (const d of denials) {
    const t = typeof d.at === "number" ? d.at : ms(d.at);
    if (!(nowMs - t <= rule.windowMs) || t > nowMs) continue;
    const k = `${d.agent}@${d.instance}`;
    byInstance.set(k, [...(byInstance.get(k) ?? []), { ...d, t }]);
  }
  return [...byInstance.values()]
    .filter((list) => list.length >= rule.denials)
    .map((list) => {
      list.sort((a, b) => a.t - b.t);
      const last = list[list.length - 1];
      return { agent: last.agent, instance: last.instance, count: list.length, evidence: last.id };
    });
}

// ── appending ────────────────────────────────────────────────────────────────

async function withLock(dir, fn) {
  const lock = path.join(dir, ".lock");
  for (let tries = 0; ; tries++) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age > LOCK_STALE_MS) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (tries > 600) throw new Error("the authority log is locked by another writer");
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function ensureDirs(dir) {
  fs.mkdirSync(path.join(dir, "streams"), { recursive: true, mode: 0o700 });
}

/**
 * Append one event: lock, verify the whole log, check the signer's right to
 * this event, sign, append, fsync. Returns the stored event.
 *   cosigners: extra roots for a root set change.
 */
export async function appendEvent(dir, stream, { kind, scope, body }, signer, { cosigners = [], now = Date.now, pin } = {}) {
  if (!STREAMS.includes(stream)) throw new Error(`unknown stream ${stream}`);
  ensureDirs(dir);
  return withLock(dir, async () => {
    const auth = loadAuthority(dir, pin ? { pin } : undefined);
    if (!auth.ok) throw new Error(`the log does not verify: ${[...auth.streams.control.errors, ...auth.streams.restrictions.errors].join("; ")}`);
    const last = auth.streams[stream].events.at(-1) ?? null;
    const nowMs = now();
    const event = {
      v: 1,
      stream,
      seq: last ? last.seq + 1 : 0,
      prev: last ? last.id : null,
      hlc: nextHlc(last?.hlc, nowMs),
      at: new Date(Math.max(nowMs, last ? ms(last.at) : 0)).toISOString(),
      kind,
      scope,
      body,
      signer: { key: signer.key, alg: signer.alg },
    };
    const bytes = signingBytes(event);
    event.id = sha256(bytes);
    event.sig = await signer.sign(bytes);
    if (cosigners.length) event.cosigs = [];
    for (const c of cosigners) event.cosigs.push({ key: c.key, alg: c.alg, sig: await c.sign(bytes) });
    // The same rules as verify, against the trust before this event.
    const fault = stream === "control" ? applyControl(auth.trust, event) : authorizeRestriction(auth.trust, event);
    if (fault) throw new Error(`refused: ${fault}`);
    const file = path.join(dir, "streams", `${stream}.jsonl`);
    const fd = fs.openSync(file, "a", 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(event)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return event;
  });
}

// ── init ─────────────────────────────────────────────────────────────────────

export function hubKeyFile(dir) {
  return path.join(dir, "hub.ed25519.pem");
}

export function loadHubSigner(dir) {
  return keySigner(crypto.createPrivateKey(fs.readFileSync(hubKeyFile(dir), "utf8")));
}

/**
 * Make the hub key and the genesis. `rootSigner` is the Secure Enclave root
 * (or a software key in tests). Writes root.pin. Refuses a second genesis.
 */
export async function initAuthority(dir, rootSigner, { now = Date.now, agents = ["*"], label = "mac" } = {}) {
  ensureDirs(dir);
  if (readLines(path.join(dir, "streams", "control.jsonl")).length) throw new Error(`${dir} already has a control stream`);
  if (!fs.existsSync(hubKeyFile(dir))) {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    fs.writeFileSync(hubKeyFile(dir), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  }
  const hub = loadHubSigner(dir);
  fs.writeFileSync(path.join(dir, "root.pin"), `${rootSigner.key}\n`, { mode: 0o600 });
  return appendEvent(
    dir,
    "control",
    {
      kind: "root.genesis",
      scope: "fleet",
      body: {
        roots: [{ alg: rootSigner.alg, public: rootSigner.public, label }],
        hub: { alg: hub.alg, public: hub.public, agents, expiresAt: new Date(now() + HUB_CERT_MAX_MS).toISOString() },
      },
    },
    rootSigner,
    { now, pin: rootSigner.key },
  );
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseFlags(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (["json"].includes(name)) flags[name] = true;
      else {
        const v = argv[++i];
        if (v === undefined) throw new Error(`${a} needs a value`);
        flags[name] = v;
      }
    } else args.push(a);
  }
  return { args, flags };
}

function defaultTool(dir) {
  return process.env.OASIS_ROOT_KEY_TOOL || path.join(dir, "bin", "oasis-root-key");
}

async function rootSigner(dir, flags) {
  return enclaveSigner(flags.tool || defaultTool(dir), path.join(dir, "root.se"));
}

function statusReport(auth, nowMs) {
  const ev = evaluateRestrictions(auth.streams.restrictions.events, auth.trust, nowMs);
  return {
    dir: auth.dir,
    pin: auth.pin,
    ok: auth.ok,
    errors: [...auth.streams.control.errors, ...auth.streams.restrictions.errors],
    roots: [...auth.trust.roots].map(([key, r]) => ({ key, label: r.label, addedAt: r.addedAt })),
    hubs: [...auth.trust.hubs].map(([key, h]) => ({ key, agents: h.agents, expiresAt: h.expiresAt, revoked: auth.trust.revoked.has(key) })),
    streams: Object.fromEntries(Object.entries(auth.streams).map(([k, s]) => [k, { events: s.events.length, head: s.head }])),
    restrictions: ev,
  };
}

export async function main(argv) {
  const [command, ...rest] = argv;
  const { args, flags } = parseFlags(rest);
  const dir = flags.dir || process.env.OASIS_AUTHORITY_DIR || DEFAULT_DIR;
  const say = (s) => console.log(s);
  switch (command) {
    case "init": {
      ensureDirs(dir);
      const tool = flags.tool || defaultTool(dir);
      const keyFile = path.join(dir, "root.se");
      if (!fs.existsSync(keyFile)) {
        const created = JSON.parse(await runTool(tool, ["create", keyFile]));
        say(`root key made in the Secure Enclave: ${fingerprint(created)}`);
      }
      say("Touch ID: sign the genesis (the root and this Mac's hub key).");
      const e = await initAuthority(dir, await enclaveSigner(tool, keyFile));
      say(`genesis ${e.id.slice(0, 12)} signed. Pin this root on every replica: ${readPin(dir)}`);
      return 0;
    }
    case "status":
    case "verify": {
      const auth = loadAuthority(dir);
      const report = statusReport(auth, Date.now());
      if (command === "verify") {
        for (const err of report.errors) say(`FAULT ${err}`);
        say(report.ok ? `ok: ${report.streams.control.events} control and ${report.streams.restrictions.events} restriction events verify` : "the log does not verify");
        return report.ok ? 0 : 1;
      }
      if (flags.json) {
        say(JSON.stringify(report, null, 2));
        return 0;
      }
      say(`authority ${dir}`);
      say(`pinned root ${report.pin ?? "NONE (run init)"}; log ${report.ok ? "verifies" : "DOES NOT VERIFY"}`);
      for (const err of report.errors) say(`  FAULT ${err}`);
      for (const r of report.roots) say(`  root ${r.key} (${r.label}) since ${r.addedAt}`);
      for (const h of report.hubs) say(`  hub  ${h.key} for ${h.agents.join(", ")} until ${h.expiresAt}${h.revoked ? " REVOKED" : ""}`);
      const ev = report.restrictions;
      say(`restrictions in force: ${ev.active.length}${ev.held.length ? `; held by the rate budget: ${ev.held.length}` : ""}`);
      for (const r of ev.active) say(`  ${r.target} ${r.level} (${r.trigger}) ${r.id.slice(0, 12)}${r.expiresAt ? ` until ${r.expiresAt}` : ""}: ${r.reason}`);
      for (const s of ev.storms) say(`  STORM issuer ${s.issuer}: ${s.held} held from ${s.from} to ${s.to}`);
      for (const r of ev.expiring) say(`  expires soon (keep or let expire): ${r.target} ${r.id.slice(0, 12)}`);
      return 0;
    }
    case "log": {
      const name = args[0] ?? "control";
      const auth = loadAuthority(dir);
      const stream = auth.streams[name];
      if (!stream) throw new Error(`unknown stream ${name}`);
      for (const e of stream.events.slice(-Number(flags.limit ?? 50))) say(`${e.seq}\t${e.at}\t${e.kind}\t${e.scope}\t${e.id.slice(0, 12)}\t${canonical(e.body)}`);
      for (const err of stream.errors) say(`FAULT ${err}`);
      return 0;
    }
    case "restrict":
    case "freeze": {
      const target = args[0];
      if (!target) throw new Error(`usage: ${command} <fleet|agent:<bot>|instance:<bot>@<container>>`);
      const hours = flags.hours ? Number(flags.hours) : null;
      const body = {
        target,
        level: command === "freeze" ? "chat-only" : flags.level,
        trigger: "mike",
        reason: flags.reason || (command === "freeze" ? "frozen by Mike" : ""),
        ...(hours ? { expiresAt: new Date(Date.now() + hours * 3600_000).toISOString() } : {}),
      };
      const e = await appendEvent(dir, "restrictions", { kind: "restriction.add", scope: target, body }, await rootSigner(dir, flags));
      say(`restriction ${e.id} added: ${target} ${body.level}`);
      return 0;
    }
    case "lift": {
      if (!args.length) throw new Error("usage: lift <id>...");
      const ids = args.map((a) => {
        const auth = loadAuthority(dir);
        const hits = auth.streams.restrictions.events.filter((e) => e.kind === "restriction.add" && e.id.startsWith(a));
        if (hits.length !== 1) throw new Error(`${a} matches ${hits.length} restrictions`);
        return hits[0].id;
      });
      const e = await appendEvent(dir, "restrictions", { kind: "restriction.lift", scope: "fleet", body: { ids } }, await rootSigner(dir, flags));
      say(`lifted ${ids.length} restriction(s) in ${e.id.slice(0, 12)}`);
      return 0;
    }
    case "void-key": {
      if (!args[0] || !flags.since) throw new Error("usage: void-key <key> --since <ISO time>");
      const e = await appendEvent(dir, "control", { kind: "key.void", scope: "fleet", body: { key: args[0], since: new Date(flags.since).toISOString() } }, await rootSigner(dir, flags));
      say(`key ${args[0]} voided from ${flags.since} in ${e.id.slice(0, 12)}`);
      return 0;
    }
    case "renew-hub": {
      const hub = loadHubSigner(dir);
      const agents = flags.agents ? flags.agents.split(",").map((a) => a.trim()) : ["*"];
      const body = { hub: { alg: hub.alg, public: hub.public, agents, expiresAt: new Date(Date.now() + HUB_CERT_MAX_MS).toISOString() } };
      const e = await appendEvent(dir, "control", { kind: "hub.cert", scope: "fleet", body }, await rootSigner(dir, flags));
      say(`hub ${hub.key} certified until ${body.hub.expiresAt} in ${e.id.slice(0, 12)}`);
      return 0;
    }
    default:
      console.error("usage: claw-authority init|status|verify|log|restrict|freeze|lift|void-key|renew-hub (see the header)");
      return 2;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err) => {
      console.error(`claw-authority: ${err.message}`);
      process.exitCode = 1;
    },
  );
}
