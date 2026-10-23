// Peer-grant ledger (CLAW-119). Design: .swarm/PEER_GRANTS.md §3.3.
//
// The autoreviewer bot is the ONLY writer. Every bot gets the ledger
// directory as a read-only mount, so no bot can approve its own grant and no
// peer can approve one by mail. Writes are temp-file + rename inside the
// ledger directory (a directory mount, not a file mount, so the rename is
// visible to readers), and every change is appended to the history file.
//
// Readers must check `expires` themselves on every use. The status field is
// tidied by sweep(), which runs on a timer, so an `active` grant can be past
// its expiry for up to one sweep interval.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LEDGER_FILE = "peer-grants.json";
export const HISTORY_FILE = "peer-grants.history.jsonl";

/** Mike, 2026-10-12: "24h max for now". */
export const MAX_TTL_HOURS = 24;
/** CLAW-124 directives: Mike 2026-10-15, a rolling 7 days. */
export const DIRECTIVE_MAX_HOURS = 168;
const DIRECTIVE_REMIND_MS = 24 * 3600 * 1000;
/** An unanswered proposal lapses after this long. */
export const PROPOSAL_TTL_MS = 60 * 60 * 1000;
/** Open proposals allowed for one requester at a time. */
export const MAX_OPEN_PER_REQUESTER = 5;

export const FAMILIES = ["exec", "file", "web", "other"];
const TOPIC_MAX = 200;
const INTENT_MAX = 1000;
const THREAD_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

export class GrantError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Strip control characters (keep newlines and tabs) and trim. */
function cleanText(s) {
  return String(s ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "")
    .trim();
}

export class GrantLedger {
  /**
   * @param {string} dir     ledger directory (read-only mount in the bots)
   * @param {object} opts
   * @param {string[]} opts.bots  fleet bot names a grant may name
   * @param {(from: string, to: string) => boolean} [opts.canMail]
   *        true when the mail relay routes from -> to (scripts/claw-mail-routes.json).
   *        A grant cannot open a pair that the relay keeps apart.
   * @param {() => number} [opts.now]
   */
  constructor(dir, { bots, canMail = () => true, now = Date.now } = {}) {
    this.dir = dir;
    this.file = join(dir, LEDGER_FILE);
    this.history = join(dir, HISTORY_FILE);
    this.bots = new Set(bots ?? []);
    this.canMail = canMail;
    this.now = now;
    mkdirSync(dir, { recursive: true });
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { version: 1, grants: [] };
  }

  iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }

  save(event) {
    const tmp = join(this.dir, `.${LEDGER_FILE}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o644 });
    renameSync(tmp, this.file);
    appendFileSync(this.history, JSON.stringify({ ts: this.iso(), ...event }) + "\n");
  }

  get(id) {
    return this.data.grants.find((g) => g.id === id) ?? null;
  }

  list({ statuses } = {}) {
    return this.data.grants.filter((g) => !statuses || statuses.includes(g.status));
  }

  nextId(prefix = "GRANT") {
    const n = this.data.grants
      .filter((g) => g.id.startsWith(`${prefix}-`))
      .reduce((m, g) => Math.max(m, Number(g.id.split("-")[1]) || 0), 0);
    return `${prefix}-${String(n + 1).padStart(4, "0")}`;
  }

  /**
   * CLAW-124: a directive is Mike's standing approval for ONE bot's lane work,
   * in any session, for up to 7 days. Stored in this ledger (kind "directive")
   * so the reviewer reads it from the same read-only file. `proposer` is "mike"
   * (from Telegram) or a bot from its source address: a bot may propose only for
   * itself, a coordinator for any bot. It is active only after Mike's press.
   */
  proposeDirective(proposer, body, { coordinators = [] } = {}) {
    const b = body ?? {};
    const bot = String(b.bot ?? "");
    if (!this.bots.has(bot)) throw new GrantError(`bot: unknown bot ${bot}`);
    // "console" (CLAW-127) reaches here only from the host-only folder, never from the API.
    if (proposer !== "mike" && proposer !== "console") {
      if (!this.bots.has(proposer)) throw new GrantError(`unknown proposer ${proposer}`, 403);
      if (proposer !== bot && !coordinators.includes(proposer))
        throw new GrantError(`${proposer} may propose a directive only for itself`, 403);
    }
    const goal = cleanText(b.goal);
    const may = cleanText(b.may) || "work toward the goal with your usual tools, repos and lane peers";
    const mustNot = cleanText(b.must_not) || "anything outside the goal";
    const lane = cleanText(b.lane).slice(0, 80) || null;
    if (!goal || goal.length > 300) throw new GrantError("goal: 1-300 chars");
    if (may.length > 600 || mustNot.length > 600) throw new GrantError("may / must_not: at most 600 chars each");
    const ttl = b.ttl_hours === undefined ? DIRECTIVE_MAX_HOURS : Number(b.ttl_hours);
    if (!(ttl > 0 && ttl <= DIRECTIVE_MAX_HOURS)) throw new GrantError(`ttl_hours: more than 0, at most ${DIRECTIVE_MAX_HOURS}`);
    let pathPrefixes = null;
    if (b.path_prefixes !== undefined) {
      if (!Array.isArray(b.path_prefixes) || b.path_prefixes.length > 10 || b.path_prefixes.some((p) => typeof p !== "string" || !p.startsWith("/") || p.includes("..")))
        throw new GrantError("path_prefixes: up to 10 absolute paths without '..'");
      pathPrefixes = b.path_prefixes;
    }
    this.sweep();
    const now = this.now();
    const d = {
      id: this.nextId("DIR"),
      kind: "directive",
      status: "proposed",
      requester: proposer,
      grantees: [bot],
      thread_id: null,
      lane,
      topic: goal,
      intent: may,
      must_not: mustNot,
      requested_ttl_hours: ttl,
      families: null,
      path_prefixes: pathPrefixes,
      max_actions: null,
      proposed_at: this.iso(now),
      proposal_expires: this.iso(now + PROPOSAL_TTL_MS),
      approved_at: null,
      expires: null,
      decided_by: null,
      card: null,
      reminded: false,
    };
    this.data.grants.push(d);
    this.save({ event: "directive_proposed", id: d.id, proposer, bot });
    return d;
  }

  /** Rolling renewal: a live directive runs `hours` from now. */
  renew(id, hours, by) {
    this.sweep();
    const g = this.get(id);
    if (!g || g.kind !== "directive") throw new GrantError(`no directive ${id}`, 404);
    if (g.status !== "active") throw new GrantError(`${id} is ${g.status}`, 409);
    const h = Number(hours);
    if (!(h > 0 && h <= DIRECTIVE_MAX_HOURS)) throw new GrantError(`at most ${DIRECTIVE_MAX_HOURS} h`);
    g.expires = this.iso(this.now() + h * 3600 * 1000);
    g.reminded = false;
    this.save({ event: "directive_renewed", id, hours: h, by });
    return g;
  }

  /** Active directives ending within 24 h that have not had a reminder. */
  dueReminders() {
    const now = this.now();
    return this.data.grants.filter(
      (g) => g.kind === "directive" && g.status === "active" && !g.reminded && Date.parse(g.expires) - now <= DIRECTIVE_REMIND_MS,
    );
  }

  markReminded(id) {
    const g = this.get(id);
    if (!g) return;
    g.reminded = true;
    this.save({ event: "directive_reminded", id });
  }

  /**
   * Record a proposal. `requester` comes from the caller's source address
   * (see clientmap.mjs), NEVER from the request body.
   * Returns { grant, duplicate }.
   */
  propose(requester, body) {
    if (!this.bots.has(requester)) throw new GrantError(`unknown requester ${requester}`, 403);
    const b = body ?? {};
    const grantees = Array.isArray(b.grantees) ? [...new Set(b.grantees.map(String))] : [];
    if (grantees.length === 0) throw new GrantError("grantees: at least one bot");
    for (const g of grantees) {
      if (!this.bots.has(g)) throw new GrantError(`grantees: unknown bot ${g}`);
      if (g === requester) throw new GrantError("grantees: a bot cannot grant itself");
      if (!this.canMail(requester, g)) throw new GrantError(`grantees: the mail relay has no route ${requester} -> ${g}`);
    }
    const threadId = String(b.thread_id ?? "");
    if (!THREAD_RE.test(threadId)) throw new GrantError("thread_id: 1-80 chars of [A-Za-z0-9_.:-]");
    const topic = cleanText(b.topic);
    const intent = cleanText(b.intent);
    if (!topic || topic.length > TOPIC_MAX) throw new GrantError(`topic: 1-${TOPIC_MAX} chars`);
    if (!intent || intent.length > INTENT_MAX) throw new GrantError(`intent: 1-${INTENT_MAX} chars`);
    const ttl = Number(b.ttl_hours);
    if (!(ttl > 0 && ttl <= MAX_TTL_HOURS)) throw new GrantError(`ttl_hours: more than 0, at most ${MAX_TTL_HOURS}`);
    let families = null;
    if (b.families !== undefined) {
      if (!Array.isArray(b.families) || b.families.some((f) => !FAMILIES.includes(f)))
        throw new GrantError(`families: a subset of ${FAMILIES.join(", ")}`);
      families = [...new Set(b.families)];
    }
    let pathPrefixes = null;
    if (b.path_prefixes !== undefined) {
      if (
        !Array.isArray(b.path_prefixes) ||
        b.path_prefixes.length > 10 ||
        b.path_prefixes.some((p) => typeof p !== "string" || !p.startsWith("/") || p.includes("..") || p.length > 300)
      )
        throw new GrantError("path_prefixes: up to 10 absolute paths without '..'");
      pathPrefixes = b.path_prefixes;
    }
    let maxActions = null;
    if (b.max_actions !== undefined) {
      maxActions = Number(b.max_actions);
      if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 500)
        throw new GrantError("max_actions: an integer from 1 to 500");
    }

    this.sweep();
    // An identical request returns the open proposal, or the grant that is
    // already active, so a bot that asks again after Mike answered gets the
    // live grant and Mike gets no second card (live test, 2026-10-13).
    const now0 = this.now();
    const same = this.data.grants.find(
      (g) =>
        (g.status === "proposed" || (g.status === "active" && Date.parse(g.expires) > now0)) &&
        g.requester === requester &&
        g.thread_id === threadId &&
        g.topic === topic &&
        g.intent === intent &&
        g.grantees.join(",") === [...grantees].sort().join(","),
    );
    if (same) return { grant: same, duplicate: true };
    const open = this.data.grants.filter((g) => g.status === "proposed" && g.requester === requester).length;
    if (open >= MAX_OPEN_PER_REQUESTER)
      throw new GrantError(`${requester} already has ${open} open proposals; wait for Mike to answer`, 429);

    const now = this.now();
    const grant = {
      id: this.nextId(),
      status: "proposed",
      requester,
      grantees: [...grantees].sort(),
      thread_id: threadId,
      topic,
      intent,
      requested_ttl_hours: ttl,
      families,
      path_prefixes: pathPrefixes,
      max_actions: maxActions,
      proposed_at: this.iso(now),
      proposal_expires: this.iso(now + PROPOSAL_TTL_MS),
      approved_at: null,
      expires: null,
      decided_by: null,
      card: null,
    };
    this.data.grants.push(grant);
    this.save({ event: "proposed", id: grant.id, requester });
    return { grant, duplicate: false };
  }

  setCard(id, card) {
    const g = this.get(id);
    if (!g) return;
    g.card = card;
    this.save({ event: "card", id, card });
  }

  /** Mike's answer. ttlHours null means deny. Only a proposed grant can be decided. */
  decide(id, ttlHours, decidedBy) {
    this.sweep();
    const g = this.get(id);
    if (!g) throw new GrantError(`no grant ${id}`, 404);
    if (g.status !== "proposed") throw new GrantError(`${id} is ${g.status}, not proposed`, 409);
    const now = this.now();
    if (ttlHours === null) {
      g.status = "denied";
    } else {
      const ttl = Number(ttlHours);
      const max = g.kind === "directive" ? DIRECTIVE_MAX_HOURS : MAX_TTL_HOURS;
      if (!(ttl > 0 && ttl <= max)) throw new GrantError(`ttl: at most ${max} h`);
      g.status = "active";
      g.approved_at = this.iso(now);
      g.expires = this.iso(now + ttl * 3600 * 1000);
    }
    g.decided_by = decidedBy;
    this.save({ event: g.status, id, ttl_hours: ttlHours, decided_by: decidedBy });
    return g;
  }

  revoke(id, reason, by) {
    const g = this.get(id);
    if (!g) throw new GrantError(`no grant ${id}`, 404);
    if (g.status !== "active" && g.status !== "proposed") throw new GrantError(`${id} is ${g.status}`, 409);
    g.status = "revoked";
    g.revoked_at = this.iso();
    g.revoke_reason = cleanText(reason).slice(0, 200) || null;
    this.save({ event: "revoked", id, by, reason: g.revoke_reason });
    return g;
  }

  /** Mark expired grants and lapsed proposals. Returns the grants it changed. */
  sweep() {
    const now = this.now();
    const changed = [];
    for (const g of this.data.grants) {
      if (g.status === "active" && Date.parse(g.expires) <= now) {
        g.status = "expired";
        changed.push(g);
      } else if (g.status === "proposed" && Date.parse(g.proposal_expires) <= now) {
        g.status = "lapsed";
        changed.push(g);
      }
    }
    if (changed.length) {
      this.save({ event: "sweep", ids: changed.map((g) => `${g.id}:${g.status}`) });
      // Any caller can trigger a sweep; the bot closes the cards from here so
      // that no lapsed proposal keeps live buttons.
      if (this.onSweep) void Promise.resolve(this.onSweep(changed)).catch(() => {});
    }
    return changed;
  }
}
