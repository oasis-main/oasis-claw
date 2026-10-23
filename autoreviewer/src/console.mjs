// Console directive proposals (CLAW-127). Claude Code, the host operator, may
// propose a standing directive for any bot, as the coordinator can (Mike,
// 2026-10-23). It writes one JSON file into a folder that only the Mac and
// this container mount: no bot mounts it, and it adds no network route, so a
// bot cannot propose as "console". A proposal only opens Mike's card; the
// directive is active only after his press, exactly as for a bot's proposal.
//
// Folder layout (AUTOREVIEWER_CONSOLE_DIR):
//   inbox/<name>.json   one proposal, the same body as POST /v1/directives
//   done/<name>.json    the result: { ok, id, bot, status } or { ok: false, error }
// The writer creates <name>.tmp and renames it, so a half-written file is never read.

import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CONSOLE = "console";
const MAX_BYTES = 8192;

export class ConsoleProposals {
  /**
   * @param {string} dir
   * @param {{ ledger: object, bot: object, log?: (row: object) => void }} o
   */
  constructor(dir, { ledger, bot, log = () => {} }) {
    this.inbox = join(dir, "inbox");
    this.done = join(dir, "done");
    mkdirSync(this.inbox, { recursive: true });
    mkdirSync(this.done, { recursive: true });
    this.ledger = ledger;
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
    let d;
    try {
      // lstat: a symlink is refused and removed, never followed.
      const st = lstatSync(path);
      if (!st.isFile()) throw new Error("not a regular file");
      if (st.size > MAX_BYTES) throw new Error(`larger than ${MAX_BYTES} bytes`);
      d = this.ledger.proposeDirective(CONSOLE, JSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
      return { ok: false, error: String(err.message ?? err) };
    }
    this.log({ event: "directive_proposed", id: d.id, proposer: CONSOLE, bot: d.grantees[0] });
    try {
      await this.bot.sendDirectiveCard(d);
    } catch (err) {
      // No card means Mike cannot answer; close the proposal at once (as the API does).
      this.ledger.revoke(d.id, "the card could not be sent to Mike", "autoreviewer");
      this.log({ event: "card_send_failed", id: d.id, error: String(err.message ?? err) });
      return { ok: false, id: d.id, error: "the card could not be sent to Mike" };
    }
    return { ok: true, id: d.id, bot: d.grantees[0], status: d.status };
  }
}
