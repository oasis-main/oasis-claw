import { randomBytes } from "node:crypto";

// ── Inter-bot mail envelope (CLAW-076) ────────────────────────────────────────
// The wire format for a peer message. Bots NEVER share a writable tree; a bot
// drops an envelope in its own /reach/mail/outbox and the HOST-SIDE RELAY
// (scripts/claw-mail-relay.mjs) validates it and moves it into each recipient's
// /reach/mail/inbox with write-temp-then-rename (atomic, no locking).
//
// `from` is NOT part of the sender-authored envelope: the relay STAMPS it from
// the outbox directory the file came out of, which a container cannot spoof.
// This mirrors the reviewer's rule that identity comes from the source, never
// from attacker-authorable content.

export type MailKind = "dm" | "project" | "broadcast";
export const MAIL_KINDS: readonly MailKind[] = ["dm", "project", "broadcast"];

// Caps — enforced by BOTH the send tool (fail fast, good error) and the relay
// (the real gate — a bot cannot talk the relay down). Keep the two in sync.
export const MAX_SUBJECT_CHARS = 200;
export const MAX_BODY_CHARS = 16_000;
export const MAX_RECIPIENTS = 8;
export const MAX_REFS = 32;
export const MAX_WORK_ITEMS = 16;
export const MAX_WORK_REPOS = 16;

// ── Structured work references (Mike 2026-07-31) ──────────────────────────────
// A message may POINT AT concrete work: .swarm work-item ids (e.g. "CLAW-076")
// and repositories (e.g. "oasis-cloud" or "org/repo"). This is deliberately NOT
// meta-messaging ABOUT .swarm — .swarm is already the project-native board. It is
// a typed handle so sender and recipient (and a later memory_search / fs_grep)
// can track exactly which item/repo a conversation concerns without duplicating
// .swarm content.
export interface WorkRefs {
  items: string[]; // .swarm work-item ids
  repos: string[]; // repository identifiers
}

/** A .swarm item id token: permissive but bounded, no whitespace/control. */
export function isWorkItem(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(s);
}
/** A repo identifier: slug or org/repo form, bounded, no whitespace/control. */
export function isRepoRef(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(s);
}

/** What a bot authors and writes to its outbox. No `from` — the relay stamps it. */
export interface OutboundEnvelope {
  id: string;
  to: string[];
  kind: MailKind;
  subject: string;
  body: string;
  refs: string[];
  work: WorkRefs;
  thread_id: string;
  ts: string;
}

/** What the relay writes to a recipient inbox: the outbound plus a stamped `from`. */
export interface DeliveredEnvelope extends OutboundEnvelope {
  from: string;
}

/** A short, filesystem-safe, collision-resistant message id. */
export function newMessageId(): string {
  // No timestamp-in-id dependency on the clock for uniqueness; the ts field
  // carries time. 12 random bytes = 24 hex chars, ample for the fleet's volume.
  return "m_" + randomBytes(12).toString("hex");
}

/** True when a token is a safe bot key (relay routes + inbox filenames use it). */
export function isBotKey(s: unknown): s is string {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(s);
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Structural + size validation for a sender-authored envelope. The relay runs
 * this too (defense in depth) — the send tool runs it to fail fast with a
 * useful message before anything hits the outbox.
 */
export function validateOutbound(e: unknown): ValidationResult {
  const errors: string[] = [];
  const o = (e ?? {}) as Record<string, unknown>;

  if (typeof o.id !== "string" || !/^m_[0-9a-f]{6,}$/.test(o.id)) errors.push("id: missing or malformed");
  if (!Array.isArray(o.to) || o.to.length === 0) errors.push("to: must be a non-empty array of bot keys");
  else {
    if (o.to.length > MAX_RECIPIENTS) errors.push(`to: too many recipients (max ${MAX_RECIPIENTS})`);
    for (const r of o.to) if (!isBotKey(r)) errors.push(`to: "${String(r)}" is not a valid bot key`);
  }
  if (typeof o.kind !== "string" || !MAIL_KINDS.includes(o.kind as MailKind)) errors.push(`kind: must be one of ${MAIL_KINDS.join("|")}`);
  if (typeof o.subject !== "string") errors.push("subject: must be a string");
  else if (o.subject.length > MAX_SUBJECT_CHARS) errors.push(`subject: too long (max ${MAX_SUBJECT_CHARS} chars)`);
  if (typeof o.body !== "string") errors.push("body: must be a string");
  else if (o.body.length > MAX_BODY_CHARS) errors.push(`body: too long (max ${MAX_BODY_CHARS} chars)`);
  if (o.refs !== undefined) {
    if (!Array.isArray(o.refs)) errors.push("refs: must be an array of strings");
    else if (o.refs.length > MAX_REFS) errors.push(`refs: too many (max ${MAX_REFS})`);
    else for (const r of o.refs) if (typeof r !== "string") errors.push("refs: entries must be strings");
  }
  if (o.work !== undefined) {
    const w = o.work as Record<string, unknown>;
    if (typeof w !== "object" || w === null) errors.push("work: must be an object {items[],repos[]}");
    else {
      if (w.items !== undefined) {
        if (!Array.isArray(w.items) || w.items.length > MAX_WORK_ITEMS) errors.push(`work.items: array, max ${MAX_WORK_ITEMS}`);
        else for (const it of w.items) if (!isWorkItem(it)) errors.push(`work.items: "${String(it)}" is not a valid .swarm item id`);
      }
      if (w.repos !== undefined) {
        if (!Array.isArray(w.repos) || w.repos.length > MAX_WORK_REPOS) errors.push(`work.repos: array, max ${MAX_WORK_REPOS}`);
        else for (const rp of w.repos) if (!isRepoRef(rp)) errors.push(`work.repos: "${String(rp)}" is not a valid repo id`);
      }
    }
  }
  if (o.thread_id !== undefined && typeof o.thread_id !== "string") errors.push("thread_id: must be a string");
  if (typeof o.ts !== "string") errors.push("ts: must be an ISO timestamp string");

  return { ok: errors.length === 0, errors };
}

// ── Read receipts (retention support) ─────────────────────────────────────────
// The read cursor lives inside the bot's container home, which the host relay
// cannot see. So when a bot reads mail, the plugin also drops a tiny receipt into
// its OUTBOX; the relay consumes it (never delivers it) and records read-status
// host-side, which lets the relay's retention sweep archive READ+old messages
// without ever touching UNREAD mail (so the unread-count invariant holds). The
// receipt filename is prefixed `_receipt_` so the relay routes it before the
// peer-message loop and it never counts against the send rate limit.
export const RECEIPT_PREFIX = "_receipt_";
export interface ReadReceipt {
  type: "read_receipt";
  ids: string[];
  ts: string;
}
export function isReadReceipt(o: unknown): o is ReadReceipt {
  const r = o as Record<string, unknown>;
  return !!r && r.type === "read_receipt" && Array.isArray(r.ids);
}
