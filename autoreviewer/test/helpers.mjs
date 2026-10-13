import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoreviewerBot } from "../src/bot.mjs";
import { GrantLedger } from "../src/ledger.mjs";

export const BOTS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"];
export const MIKE = 111;
export const STRANGER = 999;

export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "autoreviewer-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A clock the test moves by hand. */
export function clock(start = Date.parse("2026-10-12T12:00:00Z")) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

/** Records every Bot API call; message IDs count up from 100. */
export function fakeTelegram() {
  const calls = [];
  let nextId = 100;
  return {
    calls,
    sendMessage: async (chatId, text, replyMarkup) => {
      calls.push({ method: "sendMessage", chatId, text, replyMarkup });
      return { message_id: nextId++ };
    },
    editMessageText: async (chatId, messageId, text, replyMarkup) => {
      calls.push({ method: "editMessageText", chatId, messageId, text, replyMarkup });
      return true;
    },
    answerCallbackQuery: async (id, text) => {
      calls.push({ method: "answerCallbackQuery", id, text });
      return true;
    },
    setMyCommands: async (commands) => {
      calls.push({ method: "setMyCommands", commands });
      return true;
    },
    getUpdates: async () => [],
  };
}

export function setup() {
  const { dir, cleanup } = tempDir();
  const now = clock();
  const ledger = new GrantLedger(dir, { bots: BOTS, now });
  const telegram = fakeTelegram();
  const logs = [];
  const bot = new AutoreviewerBot({ telegram, ledger, ownerId: MIKE, chatId: MIKE, log: (r) => logs.push(r), now });
  ledger.onSweep = (changed) => bot.onSwept(changed);
  return { dir, cleanup, now, ledger, telegram, bot, logs };
}

export const PROPOSAL = {
  grantees: ["beta"],
  thread_id: "t_lane2_map",
  topic: "Price map for lane 2",
  intent: "Beta may run read-only price pulls and write notes under /work/notes/",
  ttl_hours: 4,
};

export function press(messageId, data, fromId = MIKE, chatId = MIKE) {
  return { callback_query: { id: `cq${Math.random()}`, from: { id: fromId }, message: { message_id: messageId, chat: { id: chatId } }, data } };
}

export function text(t, fromId = MIKE, chatId = MIKE) {
  return { message: { message_id: 1, from: { id: fromId }, chat: { id: chatId }, text: t } };
}
