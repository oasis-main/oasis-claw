// Observatory decisions (Mike, 2026-10-25: "browse and modify ... standing
// directives, and open permissions asks" from the fleet observatory). The
// observatory page is a second place where Mike decides, beside the Telegram
// cards. The observatory server runs on the Mac, takes a write only with its
// access key and its own Origin (scripts/claw-observatory.mjs, TRUST MODEL
// item 9), and writes one JSON file into a folder that only the Mac and this
// container mount. No bot mounts the folder and it adds no network route, so a
// bot cannot decide its own request.
//
// This container stays the only writer of the ledgers. Each decision runs the
// same ledger call as the Telegram button, then edits the Telegram card and
// mails the bots the decision concerns, so the chat and the page agree.
//
// Folder layout (AUTOREVIEWER_DECISION_DIR):
//   inbox/<name>.json   one decision (see OPS below)
//   done/<name>.json    the result: { ok, id, status, ... } or { ok: false, error }
// The writer creates <name>.tmp and renames it, so a half-written file is never read.
//
// OPS
//   { op: "decide",     id: "GRANT-0001" | "DIR-0001", hours: N | null }   null = deny
//   { op: "revoke",     id: "GRANT-0001" | "DIR-0001", reason?: "..." }
//   { op: "renew",      id: "DIR-0001", hours: N }
//   { op: "gh-decide",  id: "GH-0001", approve: true | false }
//   { op: "gh-revoke",  id: "GH-0001" }
//   { op: "directive",  bot, goal, may?, must_not?, lane?, ttl_hours?, path_prefixes? }
//                       proposed as "mike"; it opens the normal card and waits for Approve

import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { utc } from "./cards.mjs";

export const OBSERVATORY = "observatory";
const MAX_BYTES = 8192;
const GRANT_ID_RE = /^(?:GRANT|DIR)-\d{4,}$/;
const GH_ID_RE = /^GH-\d{4,}$/;

export class ObservatoryDecisions {
  /**
   * @param {string} dir
   * @param {{ ledger: object, ghStore?: object|null, bot: object, log?: (row: object) => void }} o
   */
  constructor(dir, { ledger, ghStore = null, bot, log = () => {} }) {
    this.inbox = join(dir, "inbox");
    this.done = join(dir, "done");
    mkdirSync(this.inbox, { recursive: true });
    mkdirSync(this.done, { recursive: true });
    this.ledger = ledger;
    this.ghStore = ghStore;
    this.bot = bot;
    this.log = log;
  }

  async tick() {
    const names = readdirSync(this.inbox).filter((n) => n.endsWith(".json")).sort();
    for (const name of names) {
      const path = join(this.inbox, name);
      const result = await this.handle(path);
      const tmp = join(this.done, `${name}.tmp`);
      writeFileSync(tmp, JSON.stringify(result) + "\n");
      renameSync(tmp, join(this.done, name));
      rmSync(path, { force: true });
    }
  }

  async handle(path) {
    let body;
    try {
      // lstat: a symlink is refused and removed, never followed.
      const st = lstatSync(path);
      if (!st.isFile()) throw new Error("not a regular file");
      if (st.size > MAX_BYTES) throw new Error(`larger than ${MAX_BYTES} bytes`);
      body = JSON.parse(readFileSync(path, "utf8"));
      return await this.apply(body ?? {});
    } catch (err) {
      this.log({ event: "observatory_decision_failed", op: body?.op ?? null, id: body?.id ?? null, error: String(err.message ?? err) });
      return { ok: false, error: String(err.message ?? err) };
    }
  }

  async apply(b) {
    const id = String(b.id ?? "");
    switch (b.op) {
      case "decide": {
        if (!GRANT_ID_RE.test(id)) throw new Error("id: GRANT-NNNN or DIR-NNNN");
        const hours = b.hours === null ? null : Number(b.hours);
        const g = this.ledger.decide(id, hours, OBSERVATORY);
        return this.after(g, `${g.kind === "directive" ? "directive" : "grant"}_${g.status}`, true);
      }
      case "revoke": {
        if (!GRANT_ID_RE.test(id)) throw new Error("id: GRANT-NNNN or DIR-NNNN");
        const g = this.ledger.revoke(id, b.reason ?? "revoked from the observatory", OBSERVATORY);
        return this.after(g, "revoked", true);
      }
      case "renew": {
        if (!/^DIR-\d{4,}$/.test(id)) throw new Error("id: DIR-NNNN");
        const g = this.ledger.renew(id, Number(b.hours ?? 168), OBSERVATORY);
        return this.after(g, "directive_renewed", false);
      }
      case "gh-decide":
      case "gh-revoke": {
        if (!this.ghStore) throw new Error("GitHub requests are not configured");
        if (!GH_ID_RE.test(id)) throw new Error("id: GH-NNNN");
        if (b.op === "gh-decide" && typeof b.approve !== "boolean") throw new Error("approve: true or false");
        const r = b.op === "gh-decide" ? this.ghStore.decide(id, b.approve, OBSERVATORY) : this.ghStore.revoke(id, OBSERVATORY);
        this.log({ event: `github_${r.status}`, id: r.id, by: OBSERVATORY, bot: r.bot, account: r.account, repos: r.repos, access: r.access });
        await this.bot.refreshGhCard(r);
        this.bot.notifyGithub(r);
        return { ok: true, id: r.id, status: r.status };
      }
      case "directive": {
        const { op: _op, ...proposal } = b;
        const d = this.ledger.proposeDirective("mike", proposal);
        this.log({ event: "directive_proposed", id: d.id, proposer: "mike", via: OBSERVATORY, bot: d.grantees[0] });
        try {
          await this.bot.sendDirectiveCard(d);
        } catch (err) {
          // The page can still approve it, but keep one rule: no proposal without a card.
          this.ledger.revoke(d.id, "the card could not be sent to Mike", "autoreviewer");
          return { ok: false, id: d.id, error: "the card could not be sent to Mike" };
        }
        return { ok: true, id: d.id, bot: d.grantees[0], status: d.status };
      }
      default:
        throw new Error(`unknown op ${JSON.stringify(b.op ?? null)}`);
    }
  }

  /** The same follow-up as a Telegram press: log, edit the card, mail the bots. */
  async after(g, event, notify) {
    this.log({ event, id: g.id, by: OBSERVATORY });
    await this.bot.refreshCard(g);
    if (notify) this.bot.notifyGrant(g);
    return { ok: true, id: g.id, status: g.status, expires: g.expires ?? null, ...(g.expires ? { until: utc(g.expires) } : {}) };
  }
}
