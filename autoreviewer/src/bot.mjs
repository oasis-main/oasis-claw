// The autoreviewer bot's Telegram side (CLAW-119): grant cards, button
// presses and slash commands, for Mike only.
//
// Scope (Mike, 2026-10-12): this chat is for FLEET-WIDE intents. A card about
// one bot's own action stays in that bot's own chat through openclaw. New
// fleet monitoring and maintenance commands register through
// bot.commands.register() and need no change to the update loop.
//
// Authority: an update counts only when it comes from Mike's Telegram user ID
// in the configured chat. Everything else is dropped and logged. A button
// press decides a grant only if the press is on that grant's own card.

import {
  CALLBACK,
  decidedCardText,
  directiveCardText,
  directiveDecidedText,
  directiveKeyboard,
  ghCardText,
  ghDecidedText,
  ghKeyboard,
  parseDirectiveCommand,
  utc,
  grantCardText,
  grantKeyboard,
  grantSummaryLine,
  outcomeLine,
  parseCallback,
} from "./cards.mjs";
import { directiveNotices, githubNotices, grantNotices } from "./mailer.mjs";

export class CommandRegistry {
  constructor() {
    this.commands = new Map();
  }

  /** @param {{name: string, description: string, run: (args: string, ctx: object) => Promise<string|void>|string|void}} def */
  register(def) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(def.name)) throw new Error(`bad command name ${def.name}`);
    this.commands.set(def.name, def);
  }

  get(name) {
    return this.commands.get(name) ?? null;
  }

  /** For setMyCommands. */
  menu() {
    return [...this.commands.values()].map((c) => ({ command: c.name, description: c.description.slice(0, 256) }));
  }
}

export class AutoreviewerBot {
  /**
   * @param {object} o
   * @param {import("./telegram.mjs").TelegramClient} o.telegram
   * @param {import("./ledger.mjs").GrantLedger} o.ledger
   * @param {number} o.ownerId   Mike's Telegram user ID
   * @param {number} o.chatId    the autoreviewer chat (Mike's DM with the bot by default)
   * @param {number[]} [o.ttlButtons]
   * @param {(row: object) => void} [o.log]
   * @param {() => number} [o.now]
   */
  constructor({ telegram, ledger, ghStore = null, mailer = null, coordinator = null, ownerId, chatId, ttlButtons = [1, 4, 24], log = () => {}, now = Date.now }) {
    if (!Number.isSafeInteger(ownerId) || !Number.isSafeInteger(chatId)) throw new Error("ownerId and chatId must be integers");
    this.telegram = telegram;
    this.ledger = ledger;
    this.ghStore = ghStore;
    this.mailer = mailer;
    this.coordinator = coordinator;
    this.ownerId = ownerId;
    this.chatId = chatId;
    this.ttlButtons = ttlButtons;
    this.log = log;
    this.now = now;
    this.startedAt = now();
    this.lastPollOkAt = null;
    this.offset = 0;
    this.commands = new CommandRegistry();
    // Buttons owned by optional features (e.g. the digest's "Watch" button).
    this.callbackHandlers = new Map();
    this.registerBuiltins();
  }

  isMike(fromId, chatId) {
    return fromId === this.ownerId && chatId === this.chatId;
  }

  // ── grant cards ──

  async sendGrantCard(grant) {
    const msg = await this.telegram.sendMessage(this.chatId, grantCardText(grant), grantKeyboard(grant, this.ttlButtons));
    this.ledger.setCard(grant.id, { chat_id: this.chatId, message_id: msg.message_id });
    return msg;
  }

  async refreshCard(grant) {
    if (!grant.card) return;
    try {
      const text = grant.kind === "directive" ? directiveDecidedText(grant) : decidedCardText(grant);
      await this.telegram.editMessageText(grant.card.chat_id, grant.card.message_id, text);
    } catch (err) {
      this.log({ event: "card_edit_failed", id: grant.id, error: String(err.message ?? err) });
    }
  }

  async sendGhCard(request) {
    const msg = await this.telegram.sendMessage(this.chatId, ghCardText(request), ghKeyboard(request));
    this.ghStore.setCard(request.id, { chat_id: this.chatId, message_id: msg.message_id });
    return msg;
  }

  async refreshGhCard(request) {
    if (!request.card) return;
    try {
      const minter = this.ghStore.minterStatus()[request.id];
      await this.telegram.editMessageText(request.card.chat_id, request.card.message_id, ghDecidedText(request, minter));
    } catch (err) {
      this.log({ event: "card_edit_failed", id: request.id, error: String(err.message ?? err) });
    }
  }

  /** CLAW-123: mail the bots a decision concerns (requester, grantees). */
  notifyGrant(g) {
    if (!this.mailer) return;
    const notices = g.kind === "directive" ? directiveNotices(g, this.coordinator) : grantNotices(g);
    for (const n of notices) this.mailer.send({ ...n, thread: `grant-${g.id}` });
  }

  // ── directives (CLAW-124) ──

  async sendDirectiveCard(d) {
    const msg = await this.telegram.sendMessage(this.chatId, directiveCardText(d), directiveKeyboard(d));
    this.ledger.setCard(d.id, { chat_id: this.chatId, message_id: msg.message_id });
    return msg;
  }

  /** One reminder card per directive, 24 h before it ends, with Renew. */
  async remindDirectives() {
    for (const d of this.ledger.dueReminders()) {
      try {
        await this.telegram.sendMessage(
          this.chatId,
          `Directive ${d.id} for ${d.grantees[0]} ends ${utc(d.expires)}.\nGoal: ${d.topic}`,
          { inline_keyboard: [[{ text: "Renew 7 d", callback_data: CALLBACK.dirRenew(d.id) }, { text: `Revoke ${d.id}`, callback_data: CALLBACK.revoke(d.id) }]] },
        );
        this.ledger.markReminded(d.id);
      } catch (err) {
        this.log({ event: "reminder_failed", id: d.id, error: String(err.message ?? err) });
      }
    }
  }

  async handleDirectiveCallback(cq, parsed) {
    const d = this.ledger.get(parsed.id);
    if (!d || d.kind !== "directive") {
      await this.telegram.answerCallbackQuery(cq.id, `No directive ${parsed.id}.`);
      return;
    }
    try {
      if (parsed.kind === "dir-decide") {
        if (!d.card || d.card.message_id !== cq.message.message_id) {
          await this.telegram.answerCallbackQuery(cq.id, "This button is not on the card for that directive.");
          return;
        }
        this.ledger.decide(parsed.id, parsed.hours, `telegram:${cq.from.id}`);
      } else {
        this.ledger.renew(parsed.id, 168, `telegram:${cq.from.id}`);
      }
      this.log({ event: parsed.kind === "dir-renew" ? "directive_renewed" : `directive_${d.status}`, id: d.id, bot: d.grantees[0] });
      await this.refreshCard(d);
      if (parsed.kind === "dir-decide") this.notifyGrant(d);
      await this.telegram.answerCallbackQuery(cq.id, d.status === "active" ? `${d.id} active until ${utc(d.expires)}` : `${d.id} ${d.status}`);
    } catch (err) {
      await this.telegram.answerCallbackQuery(cq.id, String(err.message ?? err).slice(0, 190));
    }
  }


  notifyGithub(r) {
    if (!this.mailer) return;
    for (const n of githubNotices(r)) this.mailer.send({ ...n, thread: `grant-${r.id}` });
  }

  /** After a sweep: close the cards of lapsed proposals and expired grants. */
  async onSwept(changed) {
    for (const g of changed) {
      await this.refreshCard(g);
      if (g.status === "lapsed" || (g.kind === "directive" && g.status === "expired")) this.notifyGrant(g);
    }
  }

  // ── updates ──

  async handleUpdate(update) {
    if (update.callback_query) return this.handleCallback(update.callback_query);
    if (update.message) return this.handleMessage(update.message);
  }

  async handleCallback(cq) {
    const chatId = cq.message?.chat?.id;
    if (!this.isMike(cq.from?.id, chatId)) {
      this.log({ event: "dropped_callback", from: cq.from?.id ?? null, chat: chatId ?? null });
      return;
    }
    const parsed = parseCallback(cq.data);
    if (!parsed) {
      await this.telegram.answerCallbackQuery(cq.id, "Unknown button.");
      return;
    }
    if (parsed.kind === "gh-decide" || parsed.kind === "gh-revoke") return this.handleGhCallback(cq, parsed);
    if (parsed.kind === "dir-decide" || parsed.kind === "dir-renew") return this.handleDirectiveCallback(cq, parsed);
    const extra = this.callbackHandlers.get(parsed.kind);
    if (extra) {
      try {
        await this.telegram.answerCallbackQuery(cq.id, String(await extra(parsed)).slice(0, 190));
      } catch (err) {
        await this.telegram.answerCallbackQuery(cq.id, String(err.message ?? err).slice(0, 190));
      }
      return;
    }
    if (!parsed.id) {
      await this.telegram.answerCallbackQuery(cq.id, "This button is not active here.");
      return;
    }
    const grant = this.ledger.get(parsed.id);
    if (!grant) {
      await this.telegram.answerCallbackQuery(cq.id, `No grant ${parsed.id}.`);
      return;
    }
    try {
      if (parsed.kind === "decide") {
        // A press decides a grant only on that grant's own card, so an old or
        // copied keyboard cannot decide a different grant.
        if (!grant.card || grant.card.message_id !== cq.message.message_id) {
          await this.telegram.answerCallbackQuery(cq.id, "This button is not on the card for that grant.");
          return;
        }
        const g = this.ledger.decide(parsed.id, parsed.ttlHours, `telegram:${cq.from.id}`);
        this.log({ event: g.status, id: g.id, ttl_hours: parsed.ttlHours });
        await this.refreshCard(g);
        this.notifyGrant(g);
        await this.telegram.answerCallbackQuery(cq.id, outcomeLine(g));
      } else {
        const g = this.ledger.revoke(parsed.id, "revoked from Telegram", `telegram:${cq.from.id}`);
        this.log({ event: "revoked", id: g.id });
        await this.refreshCard(g);
        this.notifyGrant(g);
        await this.telegram.answerCallbackQuery(cq.id, `${g.id} revoked.`);
      }
    } catch (err) {
      await this.telegram.answerCallbackQuery(cq.id, String(err.message ?? err).slice(0, 190));
      if (parsed.kind === "decide") await this.refreshCard(grant);
    }
  }

  async handleGhCallback(cq, parsed) {
    const r = this.ghStore?.get(parsed.id);
    if (!r) {
      await this.telegram.answerCallbackQuery(cq.id, `No request ${parsed.id}.`);
      return;
    }
    try {
      if (parsed.kind === "gh-decide") {
        // Same rule as grants: a press decides only on that request's own card.
        if (!r.card || r.card.message_id !== cq.message.message_id) {
          await this.telegram.answerCallbackQuery(cq.id, "This button is not on the card for that request.");
          return;
        }
        this.ghStore.decide(parsed.id, parsed.approve, `telegram:${cq.from.id}`);
      } else {
        this.ghStore.revoke(parsed.id, `telegram:${cq.from.id}`);
      }
      this.log({ event: `github_${r.status}`, id: r.id, bot: r.bot, account: r.account, repos: r.repos, access: r.access });
      await this.refreshGhCard(r);
      this.notifyGithub(r);
      await this.telegram.answerCallbackQuery(cq.id, `${r.id} ${r.status}.`);
    } catch (err) {
      await this.telegram.answerCallbackQuery(cq.id, String(err.message ?? err).slice(0, 190));
    }
  }

  async handleMessage(msg) {
    if (!this.isMike(msg.from?.id, msg.chat?.id)) {
      this.log({ event: "dropped_message", from: msg.from?.id ?? null, chat: msg.chat?.id ?? null });
      return;
    }
    const m = /^\/([a-z][a-z0-9_]*)(?:@\S+)?(?:\s+([\s\S]*))?$/i.exec(String(msg.text ?? "").trim());
    if (!m) {
      await this.telegram.sendMessage(this.chatId, "Send a command. /help lists them.");
      return;
    }
    const cmd = this.commands.get(m[1].toLowerCase());
    if (!cmd) {
      await this.telegram.sendMessage(this.chatId, `Unknown command /${m[1]}. /help lists the commands.`);
      return;
    }
    let reply;
    try {
      reply = await cmd.run((m[2] ?? "").trim(), { bot: this, message: msg });
    } catch (err) {
      reply = `/${cmd.name} failed: ${String(err.message ?? err).slice(0, 300)}`;
    }
    if (reply) await this.telegram.sendMessage(this.chatId, reply);
  }

  // ── polling ──

  async pollOnce(timeoutS = 50) {
    const updates = await this.telegram.getUpdates(this.offset, timeoutS);
    this.lastPollOkAt = this.now();
    for (const u of updates) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      try {
        await this.handleUpdate(u);
      } catch (err) {
        this.log({ event: "update_failed", update_id: u.update_id, error: String(err.message ?? err) });
      }
    }
    return updates.length;
  }

  // ── built-in commands ──

  registerBuiltins() {
    this.commands.register({
      name: "help",
      description: "List the commands",
      run: () =>
        [
          "Autoreviewer bot: fleet-wide intents only. Single-bot approvals stay in each bot's own chat.",
          "",
          ...[...this.commands.commands.values()].map((c) => `/${c.name}: ${c.description}`),
        ].join("\n"),
    });
    this.commands.register({
      name: "grants",
      description: "Active grants and open proposals, with Revoke buttons",
      run: async () => {
        this.ledger.sweep();
        const live = this.ledger.list({ statuses: ["active", "proposed"] }).filter((g) => g.kind !== "directive");
        if (live.length === 0) return "No active grants and no open proposals.";
        for (const g of live) {
          await this.telegram.sendMessage(this.chatId, grantSummaryLine(g), {
            inline_keyboard: [[{ text: `Revoke ${g.id}`, callback_data: CALLBACK.revoke(g.id) }]],
          });
        }
        return undefined;
      },
    });
    this.commands.register({
      name: "revoke",
      description: "Revoke a grant: /revoke GRANT-0001 [reason]",
      run: async (args) => {
        const [id, ...rest] = args.split(/\s+/);
        if (!/^(?:GRANT|DIR)-\d{4,}$/.test(id ?? "")) return "Usage: /revoke GRANT-0001 or DIR-0001 [reason]";
        const g = this.ledger.revoke(id, rest.join(" "), `telegram:${this.ownerId}`);
        this.log({ event: "revoked", id: g.id });
        await this.refreshCard(g);
        this.notifyGrant(g);
        return `${g.id} revoked.`;
      },
    });
    this.commands.register({
      name: "ghgrants",
      description: "GitHub access requests: open and approved, with Revoke buttons",
      run: async () => {
        if (!this.ghStore) return "GitHub requests are not configured.";
        const live = this.ghStore.list(["proposed", "approved"]);
        if (live.length === 0) return "No open or approved GitHub requests.";
        const minter = this.ghStore.minterStatus();
        for (const r of live) {
          await this.telegram.sendMessage(
            this.chatId,
            `${r.id} [${r.status}] ${r.bot} ${r.access} on ${r.account}: ${r.repos.join(", ")}\n  minter: ${minter[r.id] ?? "not applied yet"}`,
            { inline_keyboard: [[{ text: `Revoke ${r.id}`, callback_data: CALLBACK.ghRevoke(r.id) }]] },
          );
        }
        return undefined;
      },
    });
    this.commands.register({
      name: "ghrevoke",
      description: "Revoke a GitHub request: /ghrevoke GH-0001",
      run: async (args) => {
        if (!this.ghStore) return "GitHub requests are not configured.";
        const id = args.split(/\s+/)[0];
        if (!/^GH-\d{4,}$/.test(id ?? "")) return "Usage: /ghrevoke GH-0001";
        const r = this.ghStore.revoke(id, `telegram:${this.ownerId}`);
        this.log({ event: "github_revoked", id: r.id });
        await this.refreshGhCard(r);
        this.notifyGithub(r);
        return `${r.id} revoked. The minter drops it on its next run.`;
      },
    });
    this.commands.register({
      name: "directive",
      description: "Set a standing directive (rolling 7 d): /directive <bot> <goal> | may: … | must not: … | lane: … | days: N",
      run: async (args) => {
        const parsed = parseDirectiveCommand(args);
        if (!parsed) return "Usage: /directive <bot> <goal> | may: … | must not: … | lane: … | days: N (default 7)";
        const d = this.ledger.proposeDirective("mike", parsed);
        await this.sendDirectiveCard(d);
        return undefined;
      },
    });
    this.commands.register({
      name: "directives",
      description: "Standing directives with time left, Renew and Revoke buttons",
      run: async () => {
        this.ledger.sweep();
        const live = this.ledger.list({ statuses: ["active", "proposed"] }).filter((g) => g.kind === "directive");
        if (!live.length) return "No standing directives. /directive <bot> <goal> sets one.";
        for (const d of live) {
          await this.telegram.sendMessage(
            this.chatId,
            `${d.id} [${d.status}] ${d.grantees[0]}${d.lane ? ` (${d.lane})` : ""}${d.expires ? ` until ${utc(d.expires)}` : ""}\n  ${d.topic}`,
            { inline_keyboard: [[...(d.status === "active" ? [{ text: "Renew 7 d", callback_data: CALLBACK.dirRenew(d.id) }] : []), { text: `Revoke ${d.id}`, callback_data: CALLBACK.revoke(d.id) }]] },
          );
        }
        return undefined;
      },
    });
    this.commands.register({
      name: "status",
      description: "Autoreviewer bot health and grant counts",
      run: () => {
        this.ledger.sweep();
        const counts = {};
        for (const g of this.ledger.list()) counts[g.status] = (counts[g.status] ?? 0) + 1;
        const up = Math.round((this.now() - this.startedAt) / 60000);
        return [
          `Up ${up} min. Last poll ${this.lastPollOkAt ? new Date(this.lastPollOkAt).toISOString() : "never"}.`,
          `Grants: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}.`,
        ].join("\n");
      },
    });
  }
}
