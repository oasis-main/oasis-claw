// Fleet status report delivery (Mike, 2026-11-02). Replaces the weekday digest.
//
// Yes Man writes REPORT-<date>.md in the fleet folder on Monday, Wednesday and
// Friday (scripts/claw-morning, job "fleet-report") and ends it with a line
// that holds only "END OF REPORT". From 08:00 New York this bot sends:
//   1. a short message: sections 1 (decisions for Mike) and 2 (summary),
//   2. the full report as a document.
// No complete report by 12:00 gives one short notice instead. A plain-text
// reply to either message goes to the coordinator (Yes Man) by fleet mail.
//
// The report is bot-written text. It is shown to Mike as plain text (no
// parse_mode) and never acted on here.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nyParts } from "./digest.mjs";

export const REPORT_HOUR = 8;
// After this New York hour, a missing report gives one notice for the day.
export const REPORT_LATEST_HOUR = 12;
export const REPORT_DAYS = new Set(["Mon", "Wed", "Fri"]);
const END_MARK = /^END OF REPORT\s*$/m;
// The 2026-11-02 test: Yes Man wrote the end line, then ran the lint and
// rewrote the file. A scheduled send waits until the file is this old and its
// lint line is filled in.
export const SETTLE_MS = 3 * 60 * 1000;
const LINT_PENDING = /^ste_lint:\s*PENDING\b/im;
const SUMMARY_MAX = 3800;
const REPLY_MAX = 4000;
// Message IDs kept for reply routing: about two weeks of reports.
const KEEP_MESSAGES = 12;

/** Sections 1 and 2 of a report: from the first "## 1" heading to the "## 3" heading. */
export function reportSummary(text, date) {
  const body = String(text).replace(/^---\n[\s\S]*?\n---\n/, "");
  const start = body.search(/^##\s*1\b/m);
  const end = body.search(/^##\s*3\b/m);
  const part = start >= 0 ? body.slice(start, end > start ? end : undefined) : body;
  const lines = [`FLEET REPORT ${date} (written by Yes Man)`, "", part.replace(END_MARK, "").trim(), "", "The full report is attached. Reply to this message or to the file to answer Yes Man."];
  const t = lines.join("\n");
  return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX - 60)}…\n\n(cut here; the attached file has the rest)` : t;
}

export class ReportScheduler {
  /**
   * @param {object} o
   * @param {string} o.boardDir   the fleet folder (read-only mount)
   * @param {string} o.stateFile  writable state (report.json)
   * @param {import("./telegram.mjs").TelegramClient} o.telegram
   * @param {number} o.chatId
   * @param {(row: object) => void} [o.log]
   * @param {() => number} [o.now]
   */
  constructor({ boardDir, stateFile, telegram, chatId, log = () => {}, now = Date.now }) {
    this.boardDir = boardDir;
    this.stateFile = stateFile;
    this.telegram = telegram;
    this.chatId = chatId;
    this.log = log;
    this.now = now;
    this.state = { last_sent: null, messages: [] };
    try {
      if (existsSync(stateFile)) this.state = { ...this.state, ...JSON.parse(readFileSync(stateFile, "utf8")) };
    } catch {
      // A broken state file means "not sent yet today": the worst case is one extra send.
    }
  }

  save() {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.state, null, 2));
    renameSync(`${this.stateFile}.tmp`, this.stateFile);
  }

  /**
   * The complete report for a date, or null. `settled` (scheduled sends) also
   * needs a file unchanged for SETTLE_MS and a filled-in lint line.
   */
  read(date, { settled = false } = {}) {
    const p = join(this.boardDir, `REPORT-${date}.md`);
    try {
      const text = readFileSync(p, "utf8");
      if (!END_MARK.test(text)) return null;
      if (settled && (this.now() - statSync(p).mtimeMs < SETTLE_MS || LINT_PENDING.test(text))) return null;
      return text;
    } catch {
      return null;
    }
  }

  async send(date, text) {
    const ids = [];
    const m1 = await this.telegram.sendMessage(this.chatId, reportSummary(text, date));
    ids.push(m1.message_id);
    try {
      const m2 = await this.telegram.sendDocument(this.chatId, `REPORT-${date}.md`, text, `Fleet report ${date}`);
      ids.push(m2.message_id);
    } catch (err) {
      this.log({ event: "report_document_failed", date, error: String(err.message ?? err) });
    }
    this.state.messages = [...ids.map((id) => ({ id, date })), ...(this.state.messages ?? [])].slice(0, KEEP_MESSAGES);
    this.save();
    this.log({ event: "report_sent", date, messages: ids });
  }

  async tick() {
    const p = nyParts(this.now());
    if (!REPORT_DAYS.has(p.weekday) || p.hour < REPORT_HOUR || this.state.last_sent === p.date) return false;
    const text = this.read(p.date, { settled: true });
    if (text) {
      // Mark first: a send that throws must not repeat every minute.
      this.state.last_sent = p.date;
      this.save();
      await this.send(p.date, text);
      return true;
    }
    if (p.hour >= REPORT_LATEST_HOUR) {
      this.state.last_sent = p.date;
      this.save();
      await this.telegram.sendMessage(this.chatId, `FLEET REPORT ${p.date}: Yes Man did not finish REPORT-${p.date}.md by ${REPORT_LATEST_HOUR}:00 New York. /report sends it when it exists.`);
      this.log({ event: "report_missing", date: p.date });
      return true;
    }
    return false;
  }

  /** The report date a Telegram message ID belongs to, or null. */
  dateOf(messageId) {
    return (this.state.messages ?? []).find((m) => m.id === messageId)?.date ?? null;
  }
}

/** /report, and replies to a report message -> mail to the coordinator. */
export function registerReport(bot, scheduler, { mailer, coordinator }) {
  bot.commands.register({
    name: "report",
    description: "Send the newest fleet report now: /report [YYYY-MM-DD]",
    run: async (args) => {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(args.trim()) ? args.trim() : nyParts(bot.now()).date;
      const text = scheduler.read(date);
      if (!text) return `No complete REPORT-${date}.md (it must end with the line "END OF REPORT").`;
      await scheduler.send(date, text);
      return undefined;
    },
  });
  bot.replyHandler = (msg) => {
    const date = scheduler.dateOf(msg.reply_to_message?.message_id);
    if (!date) return null;
    if (!mailer || !coordinator) return "Replies are not configured (no mail outbox or coordinator).";
    const text = String(msg.text ?? "").trim();
    if (!text) return "Send your reply as text.";
    const id = mailer.send({
      to: [coordinator],
      subject: `Mike's reply to the ${date} fleet report`,
      body:
        `Mike replied to the ${date} fleet report in the autoreviewer chat. His words follow, unchanged.\n\n` +
        `${text.slice(0, REPLY_MAX)}\n\n` +
        "This mail carries Mike's steering for the fleet plan. It does not widen any directive or grant: a step outside your directives still needs Mike's approval.",
      thread: `report-${date}`,
    });
    return id ? `Sent to ${coordinator} (${id}).` : "The reply could not be queued; see the autoreviewer log.";
  };
}
