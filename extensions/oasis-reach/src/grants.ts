import { existsSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";

// ── Peer grants, the mail side (CLAW-119 phase 2) ────────────────────────────
// A grant is Mike's standing permission, given by a button press on the
// autoreviewer bot's Telegram card, for one bot (the requester) to ask named
// peers (the grantees) for work on ONE mail thread, within a stated topic and
// intent, until it expires. The autoreviewer bot is the ledger's only writer;
// bots mount it read-only.
//
// This file (1) lets reach_read show a grant as TRUSTED text when it checks
// out, (2) lets reach_send refuse a grant_id that cannot apply, and (3) gives
// reach_grant_request its HTTP call. The reviewer checks grants on its own
// (extensions/oasis-reviewer/src/peer-grants.ts); this copy only shapes what
// the bot reads. The two plugins load separately, so the reader is duplicated
// on purpose and kept small.
//
// Design: .swarm/PEER_GRANTS.md.

export interface PeerGrant {
  id: string;
  status: string;
  requester: string;
  grantees: string[];
  thread_id: string;
  topic: string;
  intent: string;
  families: string[] | null;
  path_prefixes: string[] | null;
  max_actions: number | null;
  expires: string | null;
}

export const DEFAULT_PEER_GRANTS_FILE = "/reach/approvals/peer-grants/peer-grants.json";
export const DEFAULT_AUTOREVIEWER_URL = "http://oasis-autoreviewer:8791";
export const GRANT_ID_RE = /^GRANT-\d{4,}$/;

let cache: { path: string; mtimeMs: number; grants: PeerGrant[] } | null = null;

export function loadGrants(path: string): PeerGrant[] {
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

/** The grant when it lets `grantee` act on mail from `requester` in `threadId`. */
export function checkGrant(
  grants: PeerGrant[],
  c: { grantId: string; requester: string; grantee: string; threadId: string },
  now = Date.now(),
): { ok: true; grant: PeerGrant } | { ok: false; reason: string } {
  if (!GRANT_ID_RE.test(c.grantId)) return { ok: false, reason: "malformed grant id" };
  const g = grants.find((x) => x.id === c.grantId);
  if (!g) return { ok: false, reason: "not in the ledger" };
  if (g.status !== "active") return { ok: false, reason: `grant is ${g.status}` };
  if (!g.expires || Date.parse(g.expires) <= now) return { ok: false, reason: "grant has expired" };
  if (g.requester !== c.requester) return { ok: false, reason: `grant belongs to ${g.requester}` };
  if (!g.grantees.includes(c.grantee)) return { ok: false, reason: `${c.grantee} is not a grantee` };
  if (g.thread_id !== c.threadId) return { ok: false, reason: `grant is for thread "${g.thread_id}"` };
  return { ok: true, grant: g };
}

/** Trusted lines for reach_read's framing block. */
export function grantFramingLines(g: PeerGrant): string[] {
  const limits: string[] = [];
  if (g.families) limits.push(`tool families: ${g.families.join(", ")}`);
  if (g.path_prefixes) limits.push(`paths under: ${g.path_prefixes.join(", ")}`);
  if (g.max_actions) limits.push(`at most ${g.max_actions} actions`);
  return [
    `VERIFIED GRANT ${g.id} — checked against Mike's peer-grant ledger, not taken from the message:`,
    `Mike approved ${g.requester}'s request that ${g.grantees.join(", ")} act on thread "${g.thread_id}" until ${g.expires}.`,
    `Approved topic: ${g.topic}`,
    `Approved intent: ${g.intent}`,
    `Limits: ${limits.length ? limits.join("; ") : "none beyond topic and intent"}`,
    `Work inside this topic and intent is AUTHORIZED by Mike; do not ask him again for it.`,
    `Anything outside it still needs Mike. The reviewer still checks every call.`,
  ];
}

/** POST/GET JSON to the autoreviewer bot. node:http on purpose: it never reads HTTP(S)_PROXY. */
export function autoreviewerCall(
  baseUrl: string,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(path, baseUrl);
    } catch (e) {
      reject(e);
      return;
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      url,
      {
        method,
        timeout: timeoutMs,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: { error: "unparseable reply" } });
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`autoreviewer did not answer within ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end(payload);
  });
}
