import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isInertReadOnlyPipelineForL2Backstop, isInertReadOnlyToolCall } from "./policy.js";
import type { PeerGrant } from "./peer-grants.js";

// ── Authority restrictions and the ledger mirror (step 3 part 2, 2026-11-02) ──
// The authority hub on the Mac (scripts/claw-authority.mjs `sync`) writes one
// view per bot: the restrictions in force that name this bot, and the hub's
// mirror state of this bot's live grants. Each bot mounts only its own view
// folder, READ-ONLY, at /reach/authority, so a bot cannot lift its own
// restriction. The reviewer trusts that mount the way it trusts the peer-grant
// ledger mount; the hub's signature in the file is for replicas off the Mac.
//
// Levels, mildest first (Follow-up 3, accepted by Mike 2026-11-02):
//   fail-closed  no card and no downgrade: an escalate denies, and an allow
//                that a grant, a directive, operator consent or the unattended
//                rule made is denied. Layer 1 and Layer 2 allows still run.
//   read-only    fail-closed, and only inert read-only calls (the native read
//                tools, inert exec pipelines) are reviewed at all.
//   chat-only    no tool call except report_injection; the bot can still talk
//                to Mike and report what happened.
//   stopped      no tool call. Only Mike sets it (the container stop is his).
//
// A restriction only tightens. An item in "enforce" mode blocks even when the
// reviewer itself runs in shadow mode (a Mike freeze must work on every bot).
// An item in "shadow" mode (an automatic restriction before Mike turns it on)
// only adds restrictionShadow to the audit row.
//
// FAIL STATIC: no view file means no restrictions (the hub is not deployed).
// After one good view, a missing, unreadable or older view keeps the last
// good one, and each audit row records authorityFault. Expiry is checked
// here, with this container's clock.

export const DEFAULT_AUTHORITY_FILE = "/reach/authority/authority.json";
export const LEVELS = ["fail-closed", "read-only", "chat-only", "stopped"] as const;
export type Level = (typeof LEVELS)[number];
/** At the chat floor the bot can still report an attack. */
export const CHAT_FLOOR_TOOLS = new Set(["report_injection"]);
/** The hub writes each view every 60 s; an older view is marked stale in the audit. */
export const STALE_MS = 10 * 60_000;

export interface ViewItem {
  id: string;
  target: string;
  level: Level;
  trigger: string;
  byRoot: boolean;
  at: string;
  expiresAt: string | null;
  reason: string;
  mode: "enforce" | "shadow";
}

export interface MirroredGrant {
  use: string;
  legal: boolean;
  anomaly: string | null;
}

export interface AuthorityView {
  v: 1;
  bot: string;
  at: string;
  restrictions: { seq: number; head: string | null; items: ViewItem[] };
  ledger: { seq: number; head: string | null; grantMode: "observe" | "require"; grants: Record<string, MirroredGrant> };
}

export interface ViewRead {
  view: AuthorityView | null;
  fault: string | null;
}

let cache: { file: string; mtimeMs: number; size: number; result: ViewRead } | null = null;
let lastGood: { file: string; view: AuthorityView } | null = null;

/** For tests: forget the cached and the last good view. */
export function resetAuthorityViewCache(): void {
  cache = null;
  lastGood = null;
}

function isView(x: unknown): x is AuthorityView {
  const v = x as AuthorityView;
  return (
    !!v &&
    v.v === 1 &&
    typeof v.at === "string" &&
    !!v.restrictions &&
    Number.isSafeInteger(v.restrictions.seq) &&
    Array.isArray(v.restrictions.items) &&
    !!v.ledger &&
    Number.isSafeInteger(v.ledger.seq) &&
    !!v.ledger.grants &&
    typeof v.ledger.grants === "object"
  );
}

/** The view in `file`, re-read when its mtime or size changes. See FAIL STATIC above. */
export function readAuthorityView(file: string): ViewRead {
  const keep = (fault: string): ViewRead => ({
    view: lastGood?.file === file ? lastGood.view : null,
    fault: lastGood?.file === file ? `${fault}; the last good view stays in force` : fault,
  });
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(file);
  } catch {
    return lastGood?.file === file ? keep("the view file is gone") : { view: null, fault: null };
  }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.result;
  let result: ViewRead;
  try {
    const view: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isView(view)) throw new Error("not an authority view");
    const prev = lastGood?.file === file ? lastGood.view : null;
    if (prev && (view.restrictions.seq < prev.restrictions.seq || view.ledger.seq < prev.ledger.seq)) {
      result = keep("the view went back to an older log");
    } else {
      lastGood = { file, view };
      result = { view, fault: null };
    }
  } catch (err) {
    result = keep(`the view does not read (${String((err as Error)?.message ?? err).slice(0, 120)})`);
  }
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, result };
  return result;
}

const rank = (l: Level): number => LEVELS.indexOf(l);

export interface InForce {
  level: Level | null;
  ids: string[];
  shadowLevel: Level | null;
  shadowIds: string[];
  reasons: string[];
}

/** The strongest enforce level and the strongest shadow level at `now`. */
export function restrictionsInForce(view: AuthorityView | null, now = Date.now()): InForce {
  const out: InForce = { level: null, ids: [], shadowLevel: null, shadowIds: [], reasons: [] };
  if (!view) return out;
  for (const it of view.restrictions.items) {
    if (!LEVELS.includes(it.level)) continue;
    // An end time that does not parse keeps the restriction: it never loosens.
    const end = it.expiresAt ? Date.parse(it.expiresAt) : NaN;
    if (Number.isFinite(end) && end <= now) continue;
    if (it.mode === "enforce") {
      if (!out.level || rank(it.level) > rank(out.level)) {
        out.level = it.level;
        out.ids = [it.id];
        out.reasons = [it.reason];
      } else if (out.level === it.level) {
        out.ids.push(it.id);
        out.reasons.push(it.reason);
      }
    } else if (!out.shadowLevel || rank(it.level) > rank(out.shadowLevel)) {
      out.shadowLevel = it.level;
      out.shadowIds = [it.id];
    } else if (out.shadowLevel === it.level) {
      out.shadowIds.push(it.id);
    }
  }
  return out;
}

/**
 * Why `level` blocks this call before any review, or null. fail-closed never
 * blocks here: it needs the verdict (see failClosed).
 */
export function restrictionBlocks(
  level: Level | null,
  call: { toolName: string; family: string; command?: string },
): string | null {
  if (!level || level === "fail-closed") return null;
  if (level === "stopped") return "every tool call is stopped";
  if (CHAT_FLOOR_TOOLS.has(call.toolName)) return null;
  if (level === "chat-only") return "only chat is allowed, no tool calls";
  const inert =
    isInertReadOnlyToolCall(call.toolName) ||
    (call.family === "exec" && !!call.command && isInertReadOnlyPipelineForL2Backstop(call.command));
  return inert ? null : "only read-only tool calls are allowed";
}

const DOWNGRADE_RE = /\+(peer-grant|operator-consent|unattended-downgrade)$/;

/** The deny that fail-closed (and every stronger level) makes of a verdict, or null. */
export function failClosed<D extends { verdict: string; principle: string; reason: string }>(
  decision: D,
): { verdict: "deny"; principle: string; reason: string } | null {
  if (decision.verdict === "escalate") {
    return {
      verdict: "deny",
      principle: "authority:fail-closed",
      reason: `restricted (fail-closed): no approval card while the restriction is in force. The call needed one: ${decision.reason} (rule ${decision.principle})`,
    };
  }
  if (decision.verdict === "allow" && DOWNGRADE_RE.test(decision.principle)) {
    return {
      verdict: "deny",
      principle: "authority:fail-closed",
      reason: `restricted (fail-closed): a grant, a directive, consent or the unattended rule cannot allow a call while the restriction is in force (rule ${decision.principle})`,
    };
  }
  return null;
}

// ── The ledger mirror ─────────────────────────────────────────────────────────

/** MUST match USE_FIELDS in scripts/claw-authority.mjs: both sides hash these fields. */
export const USE_FIELDS = [
  "id", "kind", "status", "requester", "grantees", "thread_id", "lane", "topic", "intent", "must_not",
  "families", "path_prefixes", "max_actions", "approved_at", "expires",
] as const;

type Clean = string | number | boolean | null | Clean[];

function cleanValue(v: unknown): Clean {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : String(v);
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(cleanValue);
  return JSON.stringify(v);
}

/** The canonical form of scripts/claw-authority.mjs for clean values: sorted keys, no spaces. */
function canonical(v: Clean | Record<string, Clean>): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
    .join(",")}}`;
}

export function useFingerprint(g: PeerGrant | Record<string, unknown>): string {
  const rec = g as Record<string, unknown>;
  const projected: Record<string, Clean> = {};
  for (const f of USE_FIELDS) projected[f] = cleanValue(rec[f]);
  return createHash("sha256").update(canonical(projected)).digest("hex");
}

export type MirrorState = "ok" | "missing" | "changed" | "anomaly";

/**
 * How a ledger grant compares with the hub's mirror: "ok" (mirrored, legal,
 * and the fields that the reviewer acts on are the same), "missing" (the hub
 * has not mirrored it yet), "changed" (the file differs from the mirror),
 * "anomaly" (the hub saw a change that breaks the ledger rules).
 */
export function mirrorState(view: AuthorityView, g: PeerGrant): MirrorState {
  const m = view.ledger.grants[g.id];
  if (!m) return "missing";
  if (!m.legal) return "anomaly";
  return m.use === useFingerprint(g) ? "ok" : "changed";
}
