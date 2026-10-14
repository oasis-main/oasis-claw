// GitHub access requests (CLAW-121, Mike 2026-10-14: "a" = card-gated).
//
// The coordinator bot asks for GitHub access for ANOTHER bot: one account,
// named repos, read or write. Mike approves or denies on a Telegram card. The
// autoreviewer bot writes approved requests to its own folder; it never sees
// the GitHub App keys or grants.json. scripts/claw-gh-minter on the Mac merges
// approved.json into the grants on each mint and writes status.json (applied,
// or a conflict it refused to resolve by widening a grant).
//
// Files in the folder (mounted read-write only into the autoreviewer bot):
//   approved.json        {"requests": [...]}  every request and its state
//   history.jsonl        append-only log
//   status.json          written by the minter: {"<id>": "applied" | "conflict: ..."}

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GrantError } from "./ledger.mjs";

export const GH_FILE = "approved.json";
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const REASON_MAX = 500;
const MAX_OPEN = 5;

export class GithubGrantStore {
  /**
   * @param {string} dir
   * @param {object} o
   * @param {string[]} o.bots        fleet bot names
   * @param {string[]} o.accounts    GitHub accounts the minter has an App on
   * @param {string[]} o.requesters  bots allowed to ask (default: the coordinator)
   * @param {() => number} [o.now]
   */
  constructor(dir, { bots, accounts, requesters, now = Date.now } = {}) {
    this.dir = dir;
    this.file = join(dir, GH_FILE);
    this.history = join(dir, "history.jsonl");
    this.statusFile = join(dir, "status.json");
    this.bots = new Set(bots ?? []);
    this.accounts = new Set(accounts ?? []);
    this.requesters = new Set(requesters ?? []);
    this.now = now;
    mkdirSync(dir, { recursive: true });
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { version: 1, requests: [] };
  }

  iso() {
    return new Date(this.now()).toISOString();
  }

  save(event) {
    const tmp = join(this.dir, `.${GH_FILE}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o644 });
    renameSync(tmp, this.file);
    appendFileSync(this.history, JSON.stringify({ ts: this.iso(), ...event }) + "\n");
  }

  get(id) {
    return this.data.requests.find((r) => r.id === id) ?? null;
  }

  list(statuses) {
    return this.data.requests.filter((r) => !statuses || statuses.includes(r.status));
  }

  /** What the minter last reported for each request id. */
  minterStatus() {
    try {
      return existsSync(this.statusFile) ? JSON.parse(readFileSync(this.statusFile, "utf8")) : {};
    } catch {
      return {};
    }
  }

  nextId() {
    const n = this.data.requests.reduce((m, r) => Math.max(m, Number(r.id.split("-")[1]) || 0), 0);
    return `GH-${String(n + 1).padStart(4, "0")}`;
  }

  /** `requester` comes from the caller's source address, never from the body. */
  propose(requester, body) {
    if (!this.requesters.has(requester)) throw new GrantError(`${requester} may not request GitHub access`, 403);
    const b = body ?? {};
    const bot = String(b.bot ?? "");
    if (!this.bots.has(bot)) throw new GrantError(`bot: unknown bot ${bot}`);
    if (bot === requester) throw new GrantError("bot: a bot cannot request access for itself");
    const account = String(b.account ?? "");
    if (!this.accounts.has(account)) throw new GrantError(`account: one of ${[...this.accounts].join(", ")}`);
    const repos = Array.isArray(b.repos) ? [...new Set(b.repos.map(String))] : [];
    if (repos.length === 0 || repos.length > 10 || repos.some((r) => !NAME_RE.test(r)))
      throw new GrantError("repos: 1-10 repository names (no wildcard; all-repos access is a Mac edit)");
    const access = String(b.access ?? "");
    if (access !== "read" && access !== "write") throw new GrantError('access: "read" or "write"');
    const reason = String(b.reason ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "").trim();
    if (!reason || reason.length > REASON_MAX) throw new GrantError(`reason: 1-${REASON_MAX} chars`);

    const same = this.data.requests.find(
      (r) =>
        (r.status === "proposed" || r.status === "approved") &&
        r.bot === bot &&
        r.account === account &&
        r.access === access &&
        r.repos.join(",") === [...repos].sort().join(","),
    );
    if (same) return { request: same, duplicate: true };
    const open = this.data.requests.filter((r) => r.status === "proposed" && r.requester === requester).length;
    if (open >= MAX_OPEN) throw new GrantError(`${requester} already has ${open} open GitHub requests`, 429);

    const request = {
      id: this.nextId(),
      status: "proposed",
      requester,
      bot,
      account,
      repos: [...repos].sort(),
      access,
      reason,
      proposed_at: this.iso(),
      decided_at: null,
      decided_by: null,
      card: null,
    };
    this.data.requests.push(request);
    this.save({ event: "proposed", id: request.id, requester, bot, account, repos: request.repos, access });
    return { request, duplicate: false };
  }

  setCard(id, card) {
    const r = this.get(id);
    if (!r) return;
    r.card = card;
    this.save({ event: "card", id });
  }

  decide(id, approve, by) {
    const r = this.get(id);
    if (!r) throw new GrantError(`no request ${id}`, 404);
    if (r.status !== "proposed") throw new GrantError(`${id} is ${r.status}, not proposed`, 409);
    r.status = approve ? "approved" : "denied";
    r.decided_at = this.iso();
    r.decided_by = by;
    this.save({ event: r.status, id, by });
    return r;
  }

  revoke(id, by) {
    const r = this.get(id);
    if (!r) throw new GrantError(`no request ${id}`, 404);
    if (r.status !== "approved" && r.status !== "proposed") throw new GrantError(`${id} is ${r.status}`, 409);
    r.status = "revoked";
    r.revoked_at = this.iso();
    this.save({ event: "revoked", id, by });
    return r;
  }
}
