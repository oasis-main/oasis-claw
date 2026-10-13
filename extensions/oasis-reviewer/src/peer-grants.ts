import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ── Peer grants (CLAW-119 phase 2) ───────────────────────────────────────────
// A peer grant is Mike's standing permission for one bot (the requester) to
// ask other bots (the grantees) for work on ONE mail thread, for a stated
// topic and intent, until it expires (24 h at most). The autoreviewer bot
// (autoreviewer/, a separate container) is the ledger's ONLY writer; it writes
// a grant as active only after Mike presses a button on its Telegram card.
// Every bot mounts the ledger directory READ-ONLY, so a bot cannot grant
// itself and a peer cannot grant one by mail.
//
// The reviewer ties a grant to a session when the bot reads (reach_read) a
// message that cites it and the grant checks out against the ledger:
//   active and unexpired, requester === the message's relay-stamped `from`,
//   this bot in grantees, and thread_id === the message's thread.
// The inbox is a read-only mount that only the relay writes, so `from` and
// thread_id in an inbox file are trustworthy; a `grant_id` there is only a
// pointer, and this file checks it.
//
// Design: .swarm/PEER_GRANTS.md.

export interface PeerGrant {
  id: string;
  status: "proposed" | "active" | "denied" | "revoked" | "lapsed" | "expired";
  requester: string;
  grantees: string[];
  thread_id: string;
  topic: string;
  intent: string;
  families: string[] | null;
  path_prefixes: string[] | null;
  max_actions: number | null;
  approved_at: string | null;
  expires: string | null;
}

export const DEFAULT_PEER_GRANTS_FILE = "/reach/approvals/peer-grants/peer-grants.json";
export const DEFAULT_MAIL_INBOX = "/reach/mail/inbox";
const GRANT_ID_RE = /^GRANT-\d{4,}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

let cache: { path: string; mtimeMs: number; grants: PeerGrant[] } | null = null;

/** All grants in the ledger file. Re-read when its mtime changes. Missing or bad file → []. */
export function loadPeerGrants(path: string): PeerGrant[] {
  try {
    if (!existsSync(path)) return [];
    const m = statSync(path).mtimeMs;
    if (cache && cache.path === path && cache.mtimeMs === m) return cache.grants;
    const data = JSON.parse(readFileSync(path, "utf8")) as { grants?: PeerGrant[] };
    const grants = Array.isArray(data.grants) ? data.grants : [];
    cache = { path, mtimeMs: m, grants };
    return grants;
  } catch {
    return [];
  }
}

export function isLive(g: PeerGrant, now = Date.now()): boolean {
  return g.status === "active" && !!g.expires && Date.parse(g.expires) > now;
}

export interface GrantCheck {
  grantId: string;
  from: string;
  self: string;
  threadId: string;
}

/** The grant if it authorizes `self` to act on mail from `from` in `threadId`, else a reason. */
export function verifyGrant(
  grants: PeerGrant[],
  c: GrantCheck,
  now = Date.now(),
): { ok: true; grant: PeerGrant } | { ok: false; reason: string } {
  if (!GRANT_ID_RE.test(c.grantId)) return { ok: false, reason: "malformed grant id" };
  const g = grants.find((x) => x.id === c.grantId);
  if (!g) return { ok: false, reason: "not in the ledger" };
  if (g.status !== "active") return { ok: false, reason: `grant is ${g.status}` };
  if (!isLive(g, now)) return { ok: false, reason: "grant has expired" };
  if (g.requester !== c.from) return { ok: false, reason: `grant belongs to ${g.requester}, message is from ${c.from}` };
  if (!g.grantees.includes(c.self)) return { ok: false, reason: `${c.self} is not a grantee` };
  if (g.thread_id !== c.threadId) return { ok: false, reason: "message is on a different thread" };
  return { ok: true, grant: g };
}

/**
 * Read the inbox envelope that a reach_read call is about to open. The relay
 * names inbox files `<from>__<id>.json`. Returns null when there is no such
 * message or it cites no grant.
 */
export function inboxGrantRef(
  inboxDir: string,
  messageId: string,
): { from: string; threadId: string; grantId: string } | null {
  if (!MESSAGE_ID_RE.test(messageId)) return null;
  try {
    const file = readdirSync(inboxDir).find((f) => f.endsWith(`__${messageId}.json`));
    if (!file) return null;
    const env = JSON.parse(readFileSync(join(inboxDir, file), "utf8")) as Record<string, unknown>;
    // The FILENAME's sender is the relay's; the body's `from` is the relay's too
    // (it overwrites it). Require both to agree.
    const fromFile = file.slice(0, file.length - `__${messageId}.json`.length);
    if (typeof env.grant_id !== "string" || env.from !== fromFile) return null;
    return { from: fromFile, threadId: typeof env.thread_id === "string" ? env.thread_id : "", grantId: env.grant_id };
  } catch {
    return null;
  }
}

/** Layer 1 limits: tool family and paths. Topic and intent are Layer 2's to judge. */
export function grantCoversCall(g: PeerGrant, call: { family: string; paths: readonly string[] }): boolean {
  if (g.families && !g.families.includes(call.family)) return false;
  if (g.path_prefixes) {
    if (call.paths.length === 0) return false;
    const under = (p: string) => g.path_prefixes!.some((pre) => p === pre || p.startsWith(pre.endsWith("/") ? pre : `${pre}/`));
    if (!call.paths.every(under)) return false;
  }
  return true;
}

/** Trusted text for the Layer 2 VERIFIED PEER GRANT block. */
export function describeGrant(g: PeerGrant): string {
  const limits: string[] = [];
  if (g.families) limits.push(`tool families: ${g.families.join(", ")}`);
  if (g.path_prefixes) limits.push(`paths under: ${g.path_prefixes.join(", ")}`);
  if (g.max_actions) limits.push(`at most ${g.max_actions} actions`);
  return [
    `${g.id}: Mike approved ${g.requester}'s request that ${g.grantees.join(", ")} act on mail thread "${g.thread_id}" until ${g.expires}.`,
    `Topic (proposed by ${g.requester}, approved by Mike): ${g.topic}`,
    `Intent (proposed by ${g.requester}, approved by Mike): ${g.intent}`,
    `Limits: ${limits.length ? limits.join("; ") : "none beyond topic and intent"}`,
  ].join("\n");
}
