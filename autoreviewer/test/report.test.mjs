import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { AutoreviewerBot } from "../src/bot.mjs";
import { GrantLedger } from "../src/ledger.mjs";
import { Mailer } from "../src/mailer.mjs";
import { registerReport, ReportScheduler, reportSummary } from "../src/report.mjs";
import { multipartBody } from "../src/telegram.mjs";
import { BOTS, MIKE, clock, fakeTelegram, tempDir, text } from "./helpers.mjs";

const REPORT = [
  "---",
  "type: fleet-status-report",
  "---",
  "# Fleet status report",
  "",
  "## 1. Decisions and actions for Mike",
  "1. Renew DIR-0010 for Nimbus.",
  "## 2. Summary",
  "- The week went well.",
  "## 3. Work done",
  "- Long detail that stays in the file.",
  "END OF REPORT",
].join("\n");

let t;
afterEach(() => t?.cleanup());

/** Write a report whose mtime is `minutesAgo` before the test clock. */
function put(board, date, text, now, minutesAgo = 10) {
  const p = join(board, `REPORT-${date}.md`);
  writeFileSync(p, text);
  const when = new Date(now() - minutesAgo * 60 * 1000);
  utimesSync(p, when, when);
}

function setup(start = "2026-11-02T13:05:00Z") {
  t = tempDir();
  const board = join(t.dir, "board");
  mkdirSync(board);
  const now = clock(Date.parse(start)); // Monday 08:05 New York (EST)
  const telegram = fakeTelegram();
  telegram.sendDocument = async (chatId, filename, content, caption) => {
    telegram.calls.push({ method: "sendDocument", chatId, filename, content, caption });
    return { message_id: 500 + telegram.calls.length };
  };
  const ledger = new GrantLedger(join(t.dir, "ledger"), { bots: BOTS, now });
  const outbox = join(t.dir, "outbox");
  const mailer = new Mailer({ outbox, now });
  const bot = new AutoreviewerBot({ telegram, ledger, mailer, coordinator: "gamma", ownerId: MIKE, chatId: MIKE, now });
  const scheduler = new ReportScheduler({ boardDir: board, stateFile: join(t.dir, "state", "report.json"), telegram, chatId: MIKE, now });
  registerReport(bot, scheduler, { mailer, coordinator: "gamma" });
  const mails = () => (existsSync(outbox) ? readdirSync(outbox).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(outbox, f), "utf8"))) : []);
  return { board, now, telegram, bot, scheduler, mails };
}

describe("reportSummary", () => {
  it("keeps sections 1 and 2 and drops the rest", () => {
    const s = reportSummary(REPORT, "2026-11-02");
    assert.match(s, /^FLEET REPORT 2026-11-02/);
    assert.match(s, /Renew DIR-0010/);
    assert.match(s, /The week went well/);
    assert.doesNotMatch(s, /Long detail/);
    assert.doesNotMatch(s, /END OF REPORT/);
  });
});

describe("ReportScheduler", () => {
  it("on Monday after 08:00 sends the summary and the file once", async () => {
    const s = setup();
    put(s.board, "2026-11-02", REPORT, s.now);
    assert.equal(await s.scheduler.tick(), true);
    assert.equal(await s.scheduler.tick(), false);
    const sent = s.telegram.calls.filter((c) => c.method === "sendMessage" || c.method === "sendDocument");
    assert.deepEqual(sent.map((c) => c.method), ["sendMessage", "sendDocument"]);
    assert.equal(sent[1].filename, "REPORT-2026-11-02.md");
    assert.equal(s.scheduler.state.messages.length, 2);
  });

  it("NEGATIVE CONTROL: an unfinished report (no END OF REPORT line) is not sent; at 12:00 one notice goes out", async () => {
    const s = setup();
    put(s.board, "2026-11-02", REPORT.replace("END OF REPORT", ""), s.now);
    assert.equal(await s.scheduler.tick(), false);
    s.now.advance(4 * 3600 * 1000); // 12:05
    assert.equal(await s.scheduler.tick(), true);
    assert.equal(await s.scheduler.tick(), false);
    const msgs = s.telegram.calls.filter((c) => c.method === "sendMessage");
    assert.equal(msgs.length, 1);
    assert.match(msgs[0].text, /did not finish REPORT-2026-11-02\.md/);
  });

  it("NEGATIVE CONTROL: nothing on Tuesday, or before 08:00", async () => {
    const tue = setup("2026-11-03T14:00:00Z");
    put(tue.board, "2026-11-03", REPORT, tue.now);
    assert.equal(await tue.scheduler.tick(), false);
    t.cleanup();
    const early = setup("2026-11-02T12:30:00Z"); // 07:30
    put(early.board, "2026-11-02", REPORT, early.now);
    assert.equal(await early.scheduler.tick(), false);
  });
});

describe("settling", () => {
  it("NEGATIVE CONTROL: a file changed in the last 3 minutes, or with ste_lint PENDING, waits", async () => {
    const s = setup();
    put(s.board, "2026-11-02", REPORT, s.now, 1);
    assert.equal(await s.scheduler.tick(), false);
    put(s.board, "2026-11-02", `ste_lint: PENDING\n${REPORT}`, s.now, 10);
    assert.equal(await s.scheduler.tick(), false);
    put(s.board, "2026-11-02", `ste_lint: 0 findings\n${REPORT}`, s.now, 10);
    assert.equal(await s.scheduler.tick(), true);
  });
});

describe("replies", () => {
  it("a reply to a report message goes to the coordinator by mail", async () => {
    const s = setup();
    put(s.board, "2026-11-02", REPORT, s.now);
    await s.scheduler.tick();
    const reportMsg = s.scheduler.state.messages[0].id;
    const reply = text("Renew DIR-0010. Pause the firmware lane.");
    reply.message.reply_to_message = { message_id: reportMsg };
    await s.bot.handleUpdate(reply);
    const mail = s.mails();
    assert.equal(mail.length, 1);
    assert.deepEqual(mail[0].to, ["gamma"]);
    assert.equal(mail[0].thread_id, "report-2026-11-02");
    assert.match(mail[0].body, /Pause the firmware lane/);
    assert.match(mail[0].body, /does not widen any directive/);
    assert.match(s.telegram.calls.at(-1).text, /^Sent to gamma/);
  });

  it("NEGATIVE CONTROL: a reply to another message is not mailed", async () => {
    const s = setup();
    const reply = text("hello");
    reply.message.reply_to_message = { message_id: 42 };
    await s.bot.handleUpdate(reply);
    assert.equal(s.mails().length, 0);
    assert.match(s.telegram.calls.at(-1).text, /Send a command/);
  });

  it("/report resends a complete report on demand", async () => {
    const s = setup();
    put(s.board, "2026-11-02", REPORT, s.now);
    await s.bot.handleUpdate(text("/report 2026-11-02"));
    assert.ok(s.telegram.calls.some((c) => c.method === "sendDocument"));
  });
});

describe("multipartBody", () => {
  it("builds fields and one file part", () => {
    const m = multipartBody({ chat_id: "1", caption: "c" }, { name: "document", filename: "R.md", type: "text/markdown", content: "# hi" });
    const body = m.body.toString("utf8");
    assert.match(m.contentType, /^multipart\/form-data; boundary=/);
    assert.match(body, /name="chat_id"\r\n\r\n1\r\n/);
    assert.match(body, /name="document"; filename="R.md"\r\nContent-Type: text\/markdown\r\n\r\n# hi\r\n/);
  });
});
