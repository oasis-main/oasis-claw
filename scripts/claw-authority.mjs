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
//   ledger        grant.state, grant.removed: the hub's signed mirror of the
//                 peer-grant and directive ledger (see LEDGER below).
//   access        access.change: one edit of a bot's access from the
//                 observatory (see ACCESS below).
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
// LEDGER (step 3 part 2)
//   The autoreviewer bot stays the only writer of peer-grants.json (CLAW-119),
//   and the JSON file stays the format that the bots read. `sync` mirrors
//   each change of a record into the ledger stream and checks the change
//   against the ledger's own rules (autoreviewer/src/ledger.mjs): a grant
//   that skips a step, outlives its maximum, or changes a fixed field is
//   mirrored with an `anomaly` and stays suspect. The mirror is a record,
//   not an approval: Mike's tap on the autoreviewer card is the approval.
//
// THE REVIEWER LINK
//   `sync` also writes one view per bot, authority-view/<bot>/authority.json
//   (outside the observatory state folder): the restrictions in force that
//   name the bot, and the mirror state of its live grants. Each bot mounts
//   only its own folder, read-only, at /reach/authority. The reviewer
//   (extensions/oasis-reviewer/src/authority.ts) applies the levels, checks
//   expiry with its own clock, and keeps the last good view when the file
//   is gone or goes back (fail static). A root restriction enforces at once;
//   an automatic one is shadow (audit only) until OASIS_AUTHORITY_AUTO=enforce.
//   OASIS_AUTHORITY_GRANTS=require makes the reviewer use only grants whose
//   mirror is legal and current (default observe: audit only).
//
// THE COUNT RULE
//   `sync` reads the deny rows of each bot's reviewer audit (docker exec) and
//   restricts an instance to fail-closed for 24 h after 5 enforced denials in
//   10 minutes. A reviewer health failure (l2:unavailable, l2FailClosed) and a
//   restriction's own deny never count, so a restriction never feeds itself.
//
// ACCESS (step 5)
//   Each edit of a bot's access that the observatory makes (a tool in
//   role.yaml, a reviewer write root) is first one signed event: what, for
//   which bot, and the hash of the file before and after. A widening (an
//   add) needs a root signature, so Touch ID; a tightening may be signed by
//   a hub certified for the bot, so one click. Verify recomputes the
//   direction from the event, so a hub key can never sign a widening.
//
// TRUST: the genesis root is pinned out of band (root.pin; `init` prints the
// fingerprint). There is no trust on first use: without a pin nothing
// verifies. Nothing here talks to the network; `sync` runs docker exec.
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
//   sync [--no-count]                   one pass: ledger mirror, count rule, views
//   daemon [--interval S]               sync on each ledger change, on each
//                                       restriction or control event, and
//                                       every S s
// A target is `fleet`, `agent:<bot>` or `instance:<bot>@<container>`.
// restrict and freeze refuse a bot that has no view folder, unless --force.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_DIR =
  process.env.OASIS_OBSERVATORY_STATE_DIR || path.join(os.homedir(), "Library", "Application Support", "oasis-x", "observatory");
export const DEFAULT_DIR = path.join(STATE_DIR, "authority");
const OASIS_DIR = path.join(os.homedir(), "Library", "Application Support", "oasis-x");
export const DEFAULT_LEDGER_FILE = path.join(OASIS_DIR, "approvals", "peer-grants", "peer-grants.json");
// Not inside the observatory state folder: no bot mounts that folder (CLAW-108).
export const DEFAULT_VIEW_DIR = path.join(OASIS_DIR, "authority-view");
export const VIEW_FILE = "authority.json";

export const STREAMS = ["control", "restrictions", "ledger", "access"];
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
export const TARGET_RE = /^(?:fleet|agent:[a-z0-9-]{1,40}|instance:[a-z0-9-]{1,40}@[a-z0-9][a-z0-9_.-]{0,80})$/;
const ID_RE = /^[0-9a-f]{64}$/;
const BOT_RE = /^[a-z0-9-]{1,40}$/;

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

function runTool(tool, args, input, timeoutMs = 180_000, timeoutHint = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else if (timedOut) reject(new Error(`${path.basename(tool)} stopped after ${timeoutMs / 1000} s with no answer${timeoutHint ? ` (${timeoutHint})` : ""}`));
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
      // The root tool waits on Touch ID, so a timeout there means nobody touched the sensor.
      const out = JSON.parse(await runTool(tool, ["sign", keyFile], bytes, 180_000, "no Touch ID?"));
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

// ── access edits (step 5) ────────────────────────────────────────────────────

/** The settings an access.change may name. A list setting widens on "add". */
export const ACCESS_SETTINGS = ["tools.alsoAllow", "reviewer.writeRoots"];
export const ACCESS_OPS = ["add", "remove"];

/** Does this access.change give the bot more than it had? */
export function accessWidening(body) {
  return body?.op === "add";
}

/** Is the signer allowed to append this access event? Error text or null. */
export function authorizeAccess(trust, event) {
  const atMs = ms(event.at);
  const b = event.body ?? {};
  const signerKey = event.signer?.key;
  const isRoot = trust.roots.has(signerKey);
  const hub = isRoot ? null : hubValidAt(trust, signerKey, atMs);
  const pool = new Map(isRoot ? [[signerKey, trust.roots.get(signerKey)]] : hub ? [[signerKey, hub]] : []);
  if (!signersOf(trust, event, pool).has(signerKey)) return isRoot || hub ? "bad signature" : "the signer is not a root or a valid hub";
  if (event.kind !== "access.change") return `unknown access kind ${event.kind}`;
  if (!BOT_RE.test(String(b.bot)) || event.scope !== `agent:${b.bot}`) return "an access change names its bot (scope agent:<bot>)";
  if (!ACCESS_SETTINGS.includes(b.setting)) return `the setting is one of ${ACCESS_SETTINGS.join(", ")}`;
  if (!ACCESS_OPS.includes(b.op)) return `the op is one of ${ACCESS_OPS.join(", ")}`;
  if (typeof b.value !== "string" || !b.value || b.value.length > 300) return "the value is a short text";
  if (typeof b.file !== "string" || !b.file || b.file.length > 300) return "the change names its file";
  if (!ID_RE.test(String(b.before)) || !ID_RE.test(String(b.after))) return "the change holds the file hash before and after";
  if (b.reason !== undefined && (typeof b.reason !== "string" || b.reason.length > 500)) return "the reason is 500 characters at most";
  if (isRoot) return null;
  // A hub: a tightening only, for a bot of its certificate.
  if (accessWidening(b)) return "a widening needs Mike's root key";
  if (!hub.agents.includes("*") && !hub.agents.includes(b.bot)) return `this hub is not certified for ${b.bot}`;
  return null;
}

// ── the ledger mirror ────────────────────────────────────────────────────────

const GRANT_ID_RE = /^(?:GRANT|DIR)-\d{4,}$/;
export const GRANT_STATUSES = ["proposed", "active", "denied", "revoked", "lapsed", "expired"];
const TERMINAL = new Set(["denied", "revoked", "lapsed", "expired"]);
/** What the mirror records of a ledger record. Cards, reminders and notes stay out. */
export const GRANT_RECORD_FIELDS = [
  "id", "kind", "status", "requester", "grantees", "thread_id", "lane", "topic", "intent", "must_not",
  "families", "path_prefixes", "max_actions", "proposed_at", "approved_at", "expires", "decided_by",
  "renewed_at", "revoked_at", "grace_until",
];
/**
 * The fields that the reviewer acts on (PeerGrant in extensions/oasis-reviewer/
 * src/peer-grants.ts). MUST match USE_FIELDS in extensions/oasis-reviewer/src/
 * authority.ts: both sides hash these fields, and a test in each pins the hash.
 */
export const USE_FIELDS = [
  "id", "kind", "status", "requester", "grantees", "thread_id", "lane", "topic", "intent", "must_not",
  "families", "path_prefixes", "max_actions", "approved_at", "expires",
];
const FIXED_FIELDS = [
  "kind", "requester", "grantees", "thread_id", "lane", "topic", "intent", "must_not",
  "families", "path_prefixes", "max_actions", "proposed_at",
];
// autoreviewer/src/ledger.mjs: MAX_TTL_HOURS, DIRECTIVE_MAX_HOURS, DIRECTIVE_GRACE_MS.
const GRANT_MAX_MS = 24 * 3600_000;
const DIRECTIVE_MAX_MS = 168 * 3600_000;
const DIRECTIVE_GRACE_MS = 4 * 3600_000;
const SLACK_MS = 60_000;

/** One value in the canonical form: a float or an object becomes text. */
function cleanValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : String(v);
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(cleanValue);
  return JSON.stringify(v);
}

export function projectGrant(g, fields = GRANT_RECORD_FIELDS) {
  return Object.fromEntries(fields.map((f) => [f, cleanValue(g?.[f])]));
}

/** The hash of the fields the reviewer acts on (the same on both sides). */
export function useFingerprint(g) {
  return sha256(canonical(projectGrant(g, USE_FIELDS)));
}

/**
 * The ledger rules that a change from `prev` to `next` breaks, as one text,
 * or null. `prev` is null for a record the mirror sees first. `observedMs`
 * is the mirror's clock: no time in a record can be later than that.
 */
export function grantAnomaly(prev, next, observedMs) {
  const problems = [];
  const directive = next.kind === "directive";
  const approved = ms(next.approved_at);
  const renewed = ms(next.renewed_at);
  const expires = ms(next.expires);
  if (!GRANT_STATUSES.includes(next.status)) problems.push(`unknown status ${next.status}`);
  if (next.status === "active" && !(Number.isFinite(approved) && Number.isFinite(expires) && next.decided_by !== null && next.decided_by !== "")) {
    problems.push("an active record has no approval time, end time or decider");
  }
  if (approved > observedMs + SLACK_MS || renewed > observedMs + SLACK_MS) problems.push("an approval or renewal time is in the future");
  if (Number.isFinite(approved) && Number.isFinite(expires)) {
    if (!directive && expires - approved > GRANT_MAX_MS + SLACK_MS) problems.push("a peer grant runs longer than 24 hours");
    // Every legal end time was set at a time no later than now, to at most 7
    // days after that time (decide, renew) or 4 hours (grace). So no legal
    // directive ends more than 7 days from now. A renewal by older ledger code
    // left no renewed_at (no start time); this bound still holds for it.
    if (directive && expires - observedMs > DIRECTIVE_MAX_MS + SLACK_MS) problems.push("a directive ends more than 7 days from now");
    const graced = next.grace_until !== null && next.grace_until === next.expires;
    if (directive && !graced && Number.isFinite(renewed) && expires - Math.max(approved, renewed) > DIRECTIVE_MAX_MS + SLACK_MS) {
      problems.push("a directive runs longer than 7 days after its renewal");
    }
  }
  if (!directive && Array.isArray(next.grantees) && next.grantees.includes(next.requester)) problems.push("a bot grants itself");
  if (prev) {
    if (TERMINAL.has(prev.status) && next.status !== prev.status) problems.push(`a ${prev.status} record became ${next.status}`);
    if (prev.status === "active" && next.status === "proposed") problems.push("an active record went back to proposed");
    for (const f of FIXED_FIELDS) if (canonical(prev[f]) !== canonical(next[f])) problems.push(`${f} changed`);
    if (prev.approved_at !== null && next.approved_at !== prev.approved_at) problems.push("approved_at changed");
    if (prev.status === "active" && next.status === "active" && next.expires !== prev.expires) {
      const renewal = directive && next.renewed_at !== null && next.renewed_at !== prev.renewed_at;
      const grace =
        directive && prev.grace_until === null && next.grace_until !== null && next.expires === next.grace_until &&
        ms(next.grace_until) <= observedMs + DIRECTIVE_GRACE_MS + SLACK_MS;
      if (!renewal && !grace) problems.push("the end time changed without a renewal");
    }
  }
  return problems.length ? problems.join("; ").slice(0, 300) : null;
}

/**
 * Checks for the ledger stream. `state` holds the mirror of each record:
 * { record, hash, legal, anomaly, removed }. A record with one anomaly stays
 * not legal (sticky), so a later clean change does not clear it.
 */
function ledgerChecker(trust) {
  const state = new Map();
  const check = (e) => {
    const signerKey = e.signer?.key;
    const isRoot = trust.roots.has(signerKey);
    const hub = isRoot ? null : hubValidAt(trust, signerKey, ms(e.at));
    const pool = new Map(isRoot ? [[signerKey, trust.roots.get(signerKey)]] : hub ? [[signerKey, hub]] : []);
    if (!signersOf(trust, e, pool).has(signerKey)) return isRoot || hub ? "bad signature" : "the signer is not a root or a valid hub";
    const b = e.body ?? {};
    if (!GRANT_ID_RE.test(String(b.id)) || e.scope !== b.id) return "a ledger event names its grant id (GRANT-n or DIR-n)";
    if (b.anomaly !== null && (typeof b.anomaly !== "string" || !b.anomaly || b.anomaly.length > 300)) return "anomaly is null or a short text";
    const cur = state.get(b.id);
    if (e.kind === "grant.state") {
      if (!b.record || typeof b.record !== "object" || Array.isArray(b.record) || b.record.id !== b.id) return "grant.state holds the record";
      if (b.hash !== sha256(canonical(b.record))) return "the record hash does not match the record";
      if (hub && !hub.agents.includes("*") && !(Array.isArray(b.record.grantees) && b.record.grantees.every((g) => hub.agents.includes(g)))) {
        return "this hub is not certified for every grantee";
      }
      state.set(b.id, { record: b.record, hash: b.hash, legal: (cur?.legal ?? true) && b.anomaly === null, anomaly: cur?.anomaly ?? b.anomaly, removed: false });
      return null;
    }
    if (e.kind === "grant.removed") {
      if (!cur || cur.removed) return "grant.removed names a record that the mirror does not hold";
      state.set(b.id, { ...cur, removed: true, legal: cur.legal && b.anomaly === null, anomaly: cur.anomaly ?? b.anomaly });
      return null;
    }
    return `unknown ledger kind ${e.kind}`;
  };
  return { check, state };
}

/** The ledger events that bring the mirror up to `grants` (the JSON file's records). */
export function planLedgerSync(state, grants, observedMs) {
  const entries = [];
  const seen = new Set();
  for (const g of grants) {
    // A second record with the same id is not mirrored: the reviewer uses the first.
    if (!g || !GRANT_ID_RE.test(String(g.id)) || seen.has(g.id)) continue;
    seen.add(g.id);
    const record = projectGrant(g);
    const hash = sha256(canonical(record));
    const cur = state.get(g.id);
    if (cur && !cur.removed && cur.hash === hash) continue;
    const anomaly = cur?.removed ? "a removed record came back" : grantAnomaly(cur ? cur.record : null, record, observedMs);
    entries.push({ kind: "grant.state", scope: g.id, body: { id: g.id, record, hash, anomaly } });
  }
  for (const [id, cur] of state) {
    if (!cur.removed && !seen.has(id)) entries.push({ kind: "grant.removed", scope: id, body: { id, anomaly: "removed from the ledger file" } });
  }
  return entries;
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

// heads.json: the last head of each stream that this hub appended. A stream
// that ends before that head, or has another event there, was truncated or
// rewritten: emptying the restrictions stream would otherwise lift every
// restriction and still verify. Same LIMIT as the hub key: a process that
// runs as Mike can change both files.
const HEADS_FILE = "heads.json";

export function readHeads(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, HEADS_FILE), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  const heads = JSON.parse(text);
  if (!heads || typeof heads !== "object" || Array.isArray(heads)) throw new Error(`${HEADS_FILE} is not an object`);
  return heads;
}

function headFault(stream, pinned) {
  if (!pinned) return null;
  const e = stream.events[pinned.seq];
  if (!e) return `the stream ends before seq ${pinned.seq}, the last head that this hub wrote (truncated or rolled back)`;
  if (e.id !== pinned.id) return `the event at seq ${pinned.seq} is not the one that this hub wrote (history rewritten)`;
  return null;
}

/**
 * Verify every stream. `checks` continue from the verified state, so an
 * append checks a new event against the same rules as verify.
 */
export function loadAuthority(dir, { pin = readPin(dir) } = {}) {
  const trust = emptyTrust(pin);
  const ledger = ledgerChecker(trust);
  const checks = {
    control: (e) => applyControl(trust, e),
    restrictions: (e) => authorizeRestriction(trust, e),
    ledger: ledger.check,
    access: (e) => authorizeAccess(trust, e),
  };
  const streams = {};
  for (const name of STREAMS) streams[name] = verifyChain(name, readLines(path.join(dir, "streams", `${name}.jsonl`)), checks[name]);
  let heads = {};
  try {
    heads = readHeads(dir);
  } catch (err) {
    streams.control.errors.push(`${HEADS_FILE} does not read: ${err.message}`);
  }
  for (const name of STREAMS) {
    const fault = streams[name].errors.length ? null : headFault(streams[name], heads[name]);
    if (fault) streams[name].errors.push(fault);
  }
  return { dir, pin, trust, streams, checks, ledger: ledger.state, ok: STREAMS.every((n) => !streams[n].errors.length) };
}

export function streamErrors(auth) {
  return STREAMS.flatMap((n) => auth.streams[n].errors.map((err) => `${n} ${err}`));
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
 * Append events to one stream: lock, verify the whole log, check the signer's
 * right to each event, sign, append, fsync. All or none. Returns the stored
 * events. `entries` is a list of { kind, scope, body }, or a function that
 * gets the verified log (under the lock) and returns that list.
 *   cosigners: extra roots for a root set change.
 */
export async function appendEvents(dir, stream, entries, signer, { cosigners = [], now = Date.now, pin } = {}) {
  if (!STREAMS.includes(stream)) throw new Error(`unknown stream ${stream}`);
  ensureDirs(dir);
  return withLock(dir, async () => {
    const auth = loadAuthority(dir, pin ? { pin } : undefined);
    if (!auth.ok) throw new Error(`the log does not verify: ${streamErrors(auth).join("; ")}`);
    const list = typeof entries === "function" ? entries(auth) : entries;
    if (!list.length) return [];
    let last = auth.streams[stream].events.at(-1) ?? null;
    const nowMs = now();
    const out = [];
    for (const { kind, scope, body } of list) {
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
      // The same rules as verify, against the state before this event.
      const fault = auth.checks[stream](event);
      if (fault) throw new Error(`refused: ${fault}`);
      out.push(event);
      last = event;
    }
    const file = path.join(dir, "streams", `${stream}.jsonl`);
    const fd = fs.openSync(file, "a", 0o600);
    try {
      fs.writeSync(fd, out.map((e) => `${JSON.stringify(e)}\n`).join(""));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const heads = readHeads(dir);
    heads[stream] = { seq: last.seq, id: last.id };
    const tmp = path.join(dir, `.${HEADS_FILE}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(heads, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, HEADS_FILE));
    return out;
  });
}

export async function appendEvent(dir, stream, entry, signer, opts) {
  return (await appendEvents(dir, stream, [entry], signer, opts))[0];
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

// ── sync: the ledger mirror, the count rule, the views ───────────────────────

function readLedgerFile(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`${file}: ${err.message}`);
  }
  if (!Array.isArray(data?.grants)) throw new Error(`${file} has no grants list`);
  return data.grants;
}

/** Mirror the ledger file into the ledger stream. A missing file mirrors nothing. */
export async function syncLedger(dir, ledgerFile, signer, { now = Date.now } = {}) {
  const grants = readLedgerFile(ledgerFile);
  if (!grants) return { missing: true, appended: [] };
  const appended = await appendEvents(dir, "ledger", (auth) => planLedgerSync(auth.ledger, grants, now()), signer, { now });
  return { missing: false, appended };
}

// Runs INSIDE a bot container (docker exec <container> node -e ...): the deny
// rows of the last 15 minutes of the last 2 MB of the reviewer audit, metadata
// only. `h` is the sha256 of the raw line: the evidence id of a restriction.
export const AUDIT_COLLECTOR = `
const fs=require("fs"),crypto=require("crypto");const f="/home/node/.openclaw/logs/reviewer/reviewer-audit.jsonl";
let txt="";try{const s=fs.statSync(f).size;const st=Math.max(0,s-2*1024*1024);const fd=fs.openSync(f,"r");const b=Buffer.alloc(s-st);fs.readSync(fd,b,0,b.length,st);fs.closeSync(fd);txt=b.toString("utf8");if(st>0)txt=txt.slice(txt.indexOf("\\n")+1);}catch(e){}
const now=Date.now(),out=[];for(const l of txt.split("\\n")){if(!l.includes('"deny"'))continue;let r;try{r=JSON.parse(l)}catch{continue}
const t=Date.parse(r.ts);if(!(now-t<=15*60000)||r.verdict!=="deny")continue;
out.push({ts:r.ts,phase:r.phase,verdict:r.verdict,enforced:r.enforced===true,principle:String(r.principle||"").slice(0,120),l2FailClosed:!!r.l2FailClosed,error:!!r.error,restriction:!!(r.restriction&&r.restriction.changed),h:crypto.createHash("sha256").update(l).digest("hex")})}
process.stdout.write(JSON.stringify(out));`;

/**
 * The audit rows that count toward the count rule: an enforced deny of a
 * tool call. A reviewer health failure never counts (Follow-up 3 rule 8), and
 * a restriction's own deny never counts (no restriction feeds itself).
 */
export function countableDenials(rows, agent, instance) {
  return rows
    .filter(
      (r) =>
        r?.phase === "before_tool_call" &&
        r.verdict === "deny" &&
        r.enforced === true &&
        !r.error &&
        !r.l2FailClosed &&
        !r.restriction &&
        !String(r.principle ?? "").startsWith("l2:unavailable") &&
        !String(r.principle ?? "").startsWith("authority:") &&
        ID_RE.test(String(r.h)) &&
        Number.isFinite(ms(r.ts)),
    )
    .map((r) => ({ id: r.h, at: r.ts, agent, instance }));
}

/**
 * The count rule: restrict each instance with 5 denials in 10 minutes to
 * fail-closed for 24 h, signed by the hub. An instance that already has a
 * count-rule restriction in force (or held by the rate budget) gets no
 * second one, and one denial is the evidence of one restriction at most.
 */
export async function applyCountRule(dir, signer, denials, { now = Date.now } = {}) {
  const nowMs = now();
  const hits = countRuleHits(denials, nowMs);
  if (!hits.length) return [];
  return appendEvents(
    dir,
    "restrictions",
    (auth) => {
      const ev = evaluateRestrictions(auth.streams.restrictions.events, auth.trust, nowMs);
      const busy = new Set([
        ...ev.active.filter((r) => r.trigger === "count-rule").map((r) => r.target),
        ...ev.held.filter((h) => nowMs - ms(h.at) < TTL_MS).map((h) => h.target),
      ]);
      const used = new Set(auth.streams.restrictions.events.filter((e) => e.kind === "restriction.add").map((e) => e.body.evidence));
      return hits
        .map((h) => ({ ...h, target: `instance:${h.agent}@${h.instance}` }))
        .filter((h) => TARGET_RE.test(h.target) && !busy.has(h.target) && !used.has(h.evidence))
        .map((h) => ({
          kind: "restriction.add",
          scope: h.target,
          body: {
            target: h.target,
            level: "fail-closed",
            trigger: "count-rule",
            reason: `${h.count} enforced denials in 10 minutes (count rule)`,
            evidence: h.evidence,
            expiresAt: new Date(nowMs + TTL_MS).toISOString(),
          },
        }));
    },
    signer,
    { now },
  );
}

/**
 * One bot's view: the restrictions in force that name the bot (fleet, the
 * agent, its current container), and the mirror state of each grant that
 * names it as a grantee and is active in the mirror or not legal. The
 * reviewer checks expiry itself, with its own clock.
 */
export function buildView(auth, { key, container }, { nowMs, autoMode = "shadow", grantMode = "observe" }) {
  const ev = evaluateRestrictions(auth.streams.restrictions.events, auth.trust, nowMs);
  const targets = new Set(["fleet", `agent:${key}`, ...(container ? [`instance:${key}@${container}`] : [])]);
  const items = ev.active
    .filter((r) => targets.has(r.target))
    .map((r) => ({
      id: r.id,
      target: r.target,
      level: r.level,
      trigger: r.trigger,
      byRoot: r.byRoot,
      at: r.at,
      expiresAt: r.expiresAt,
      reason: r.reason.slice(0, 200),
      mode: r.byRoot || autoMode === "enforce" ? "enforce" : "shadow",
    }));
  const grants = {};
  for (const [id, s] of auth.ledger) {
    if (s.removed || !Array.isArray(s.record.grantees) || !s.record.grantees.includes(key)) continue;
    if (s.record.status !== "active" && s.legal) continue;
    grants[id] = { use: useFingerprint(s.record), legal: s.legal, anomaly: s.anomaly };
  }
  const head = (name) => ({ seq: auth.streams[name].events.at(-1)?.seq ?? -1, head: auth.streams[name].head });
  return {
    v: 1,
    kind: "authority.view",
    bot: key,
    container: container ?? null,
    at: new Date(nowMs).toISOString(),
    restrictions: { ...head("restrictions"), items },
    ledger: { ...head("ledger"), grantMode, grants },
  };
}

function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

/**
 * Write <viewDir>/<bot>/authority.json for each bot, signed by the hub (for
 * replicas off this Mac; the reviewer trusts its read-only mount, as it
 * trusts peer-grants.json). A log that does not verify writes no view: the
 * bots keep the last good one (fail static).
 */
export async function publishViews(dir, viewDir, fleet, signer, { now = Date.now, autoMode, grantMode } = {}) {
  const auth = loadAuthority(dir);
  if (!auth.ok) return { written: [], fault: streamErrors(auth).join("; ") };
  const nowMs = now();
  const written = [];
  for (const bot of fleet) {
    if (!BOT_RE.test(String(bot.key))) continue;
    const view = buildView(auth, bot, { nowMs, autoMode, grantMode });
    view.hub = signer.key;
    view.sig = await signer.sign(Buffer.from(canonical(view), "utf8"));
    const folder = path.join(viewDir, bot.key);
    fs.mkdirSync(folder, { recursive: true, mode: 0o755 });
    writeAtomic(path.join(folder, VIEW_FILE), `${JSON.stringify(view, null, 2)}\n`);
    written.push(bot.key);
  }
  return { written, fault: null };
}

function dockerExec(container, script, timeoutMs = 20_000) {
  return runTool("docker", ["exec", container, "node", "-e", script], "", timeoutMs);
}

/** The fleet from the observatory's discovery: key, container, running. Excluded deployments stay out. */
async function discoverBots() {
  const { discoverFleet } = await import(new URL("./claw-observatory.mjs", import.meta.url));
  const { bots } = await discoverFleet();
  return bots.filter((b) => !b.excluded).map((b) => ({ key: b.key, container: b.container, running: b.running }));
}

/**
 * One sync pass. Each part runs even when another part fails; the errors are
 * returned. `fleet` and `collect` (container -> audit rows) are injectable.
 */
export async function syncOnce(
  dir,
  { ledgerFile = DEFAULT_LEDGER_FILE, viewDir = DEFAULT_VIEW_DIR, fleet, collect, countRule = true, now = Date.now, autoMode = "shadow", grantMode = "observe" } = {},
) {
  const hub = loadHubSigner(dir);
  const out = { ledger: [], anomalies: [], restricted: [], views: [], errors: [] };
  let bots = fleet;
  if (!bots) {
    try {
      bots = await discoverBots();
    } catch (err) {
      // No fleet, no views: the bots keep their last good view (fail static).
      out.errors.push(`fleet: ${err.message.split("\n")[0]}`);
    }
  }
  try {
    const r = await syncLedger(dir, ledgerFile, hub, { now });
    out.ledger = r.appended.map((e) => e.body.id);
    out.anomalies = r.appended.filter((e) => e.body.anomaly).map((e) => ({ id: e.body.id, anomaly: e.body.anomaly }));
  } catch (err) {
    out.errors.push(`ledger: ${err.message}`);
  }
  if (countRule && bots) {
    const read =
      collect ??
      (async (container) => {
        const out = await dockerExec(container, AUDIT_COLLECTOR);
        // Seen at night (a busy or sleeping Docker): exit 0 with no output.
        if (!out.trim()) throw new Error("the audit read printed nothing");
        return JSON.parse(out);
      });
    const denials = [];
    await Promise.all(
      bots
        .filter((b) => b.running && BOT_RE.test(String(b.key)))
        .map(async (b) => {
          try {
            denials.push(...countableDenials(await read(b.container), b.key, b.container));
          } catch (err) {
            out.errors.push(`audit ${b.key}: ${err.message.split("\n")[0]}`);
          }
        }),
    );
    try {
      out.restricted = (await applyCountRule(dir, hub, denials, { now })).map((e) => e.body.target);
    } catch (err) {
      out.errors.push(`count rule: ${err.message}`);
    }
  }
  if (bots) {
    try {
      const v = await publishViews(dir, viewDir, bots, hub, { now, autoMode, grantMode });
      out.views = v.written;
      if (v.fault) out.errors.push(`views not written, the log does not verify: ${v.fault}`);
    } catch (err) {
      out.errors.push(`views: ${err.message}`);
    }
  }
  return out;
}

// The streams whose change the daemon sends to the bots at once: Mike's
// restrict, freeze, lift and keep (CLI or the observatory page) and key.void.
// Not the ledger stream: the daemon writes that one itself.
const WATCHED_STREAMS = new Set(["restrictions.jsonl", "control.jsonl"]);

/**
 * Sync at start, after each change of the ledger folder (1 s debounce, no
 * count rule), after each change of the restrictions or control stream
 * (0.5 s debounce, no count rule) and every `intervalMs` (with the count
 * rule). One pass at a time. Logs one JSON line for a pass that changed
 * something or failed. Returns { stop } (for tests; launchd stops the CLI).
 */
export async function runDaemon(dir, { ledgerFile = DEFAULT_LEDGER_FILE, intervalMs = 60_000, log = (row) => console.log(JSON.stringify(row)), ...opts } = {}) {
  let busy = false;
  let pending = null;
  const pass = async (reason) => {
    if (busy) {
      pending = pending === "interval" ? pending : reason;
      return;
    }
    busy = true;
    try {
      const r = await syncOnce(dir, { ledgerFile, countRule: reason === "start" || reason === "interval", ...opts });
      if (r.ledger.length || r.restricted.length || r.errors.length || reason === "start") {
        log({ ts: new Date().toISOString(), reason, ledger: r.ledger.length, anomalies: r.anomalies, restricted: r.restricted, views: r.views.length, errors: r.errors });
      }
    } catch (err) {
      log({ ts: new Date().toISOString(), reason, errors: [err.message] });
    } finally {
      busy = false;
      if (pending) {
        const next = pending;
        pending = null;
        setImmediate(() => pass(next));
      }
    }
  };
  const watchers = [];
  let debounce = null;
  try {
    watchers.push(fs.watch(path.dirname(ledgerFile), () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => pass("ledger"), 1000);
    }));
  } catch (err) {
    log({ ts: new Date().toISOString(), reason: "watch", errors: [`no watch on ${path.dirname(ledgerFile)}: ${err.message}; interval only`] });
  }
  let debounceLog = null;
  try {
    watchers.push(fs.watch(path.join(dir, "streams"), (_type, name) => {
      // No name (rare on macOS): sync anyway; a pass with no change is cheap.
      if (name && !WATCHED_STREAMS.has(String(name))) return;
      clearTimeout(debounceLog);
      debounceLog = setTimeout(() => pass("log"), 500);
    }));
  } catch (err) {
    log({ ts: new Date().toISOString(), reason: "watch", errors: [`no watch on ${path.join(dir, "streams")}: ${err.message}; a restriction reaches the bots at the next interval`] });
  }
  const timer = setInterval(() => pass("interval"), intervalMs);
  await pass("start");
  return {
    stop() {
      clearInterval(timer);
      clearTimeout(debounce);
      clearTimeout(debounceLog);
      for (const w of watchers) w.close();
    },
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseFlags(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (["json", "force", "no-count"].includes(name)) flags[name] = true;
      else {
        const v = argv[++i];
        if (v === undefined) throw new Error(`${a} needs a value`);
        flags[name] = v;
      }
    } else args.push(a);
  }
  return { args, flags };
}

function modeFlag(value, allowed) {
  const v = String(value ?? allowed[0]).toLowerCase();
  if (!allowed.includes(v)) throw new Error(`${value} is not one of ${allowed.join(", ")}`);
  return v;
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
    errors: streamErrors(auth),
    roots: [...auth.trust.roots].map(([key, r]) => ({ key, label: r.label, addedAt: r.addedAt })),
    hubs: [...auth.trust.hubs].map(([key, h]) => ({ key, agents: h.agents, expiresAt: h.expiresAt, revoked: auth.trust.revoked.has(key) })),
    streams: Object.fromEntries(Object.entries(auth.streams).map(([k, s]) => [k, { events: s.events.length, head: s.head }])),
    restrictions: ev,
    ledger: {
      records: [...auth.ledger.values()].filter((s) => !s.removed).length,
      active: [...auth.ledger.values()].filter((s) => !s.removed && s.record.status === "active").length,
      anomalies: [...auth.ledger].filter(([, s]) => !s.legal).map(([id, s]) => ({ id, anomaly: s.anomaly })),
    },
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
        const n = report.streams;
        say(report.ok ? `ok: ${n.control.events} control, ${n.restrictions.events} restriction, ${n.ledger.events} ledger and ${n.access.events} access events verify` : "the log does not verify");
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
      const lg = report.ledger;
      say(`ledger mirror: ${lg.records} records, ${lg.active} active${lg.anomalies.length ? `; ${lg.anomalies.length} not legal` : ""}`);
      for (const a of lg.anomalies) say(`  ANOMALY ${a.id}: ${a.anomaly}`);
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
      // A typo would restrict no bot while Mike thinks it is restricted.
      const agent = agentOf(target);
      const viewDir = flags.views || process.env.OASIS_AUTHORITY_VIEW_DIR || DEFAULT_VIEW_DIR;
      if (agent && !flags.force && !fs.existsSync(path.join(viewDir, agent, VIEW_FILE))) {
        throw new Error(`no bot "${agent}" has a view in ${viewDir} (sync writes one per bot); check the name, or pass --force`);
      }
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
    case "sync":
    case "daemon": {
      const opts = {
        ledgerFile: flags.ledger || process.env.OASIS_AUTHORITY_LEDGER_FILE || DEFAULT_LEDGER_FILE,
        viewDir: flags.views || process.env.OASIS_AUTHORITY_VIEW_DIR || DEFAULT_VIEW_DIR,
        autoMode: modeFlag(flags.auto ?? process.env.OASIS_AUTHORITY_AUTO, ["shadow", "enforce"]),
        grantMode: modeFlag(flags.grants ?? process.env.OASIS_AUTHORITY_GRANTS, ["observe", "require"]),
      };
      if (!readPin(dir) || !fs.existsSync(hubKeyFile(dir))) throw new Error(`${dir} has no authority yet: run make authority-init`);
      if (command === "daemon") {
        await runDaemon(dir, { ...opts, intervalMs: Math.max(10, Number(flags.interval ?? 60)) * 1000 });
        return new Promise(() => {}); // runs until launchd stops it
      }
      const r = await syncOnce(dir, { ...opts, countRule: !flags["no-count"] });
      say(`ledger: ${r.ledger.length} change(s) mirrored${r.anomalies.length ? `, ${r.anomalies.length} NOT LEGAL` : ""}`);
      for (const a of r.anomalies) say(`  ANOMALY ${a.id}: ${a.anomaly}`);
      if (!flags["no-count"]) say(`count rule: ${r.restricted.length ? r.restricted.join(", ") : "no new restriction"}`);
      say(`views: ${r.views.length ? r.views.join(", ") : "none written"} (automatic restrictions ${opts.autoMode}, grants ${opts.grantMode})`);
      for (const err of r.errors) say(`ERROR ${err}`);
      return r.errors.length ? 1 : 0;
    }
    default:
      console.error("usage: claw-authority init|status|verify|log|restrict|freeze|lift|void-key|renew-hub|sync|daemon (see the header)");
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
