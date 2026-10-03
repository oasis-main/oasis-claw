// Tests for the CLAW-090 thread hop budget (Mike, 2026-09-04: "authorize
// collaboration chains up to a certain point and scope"). A separate file
// from claw-mail-relay.test.mjs on purpose: these tests need MANY sends from
// the same sender in a row, which would collide with that file's deliberately
// low rateLimit.perSenderPerMinute (kept low there to test the limiter
// itself). This file sets a generous rate limit so the hop budget, not the
// rate limiter, is what each assertion actually exercises.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";

const ROOT = mkdtempSync(join(tmpdir(), "mailhopbudget-"));
const ROUTES = join(ROOT, "routes.json");

process.env.CLAW_MAIL_ROOT = ROOT;
process.env.CLAW_MAIL_ROUTES = ROUTES;

const HOP_BUDGET = 3;

writeFileSync(
  ROUTES,
  JSON.stringify({
    routes: [
      { from: "house", to: "kolmogorov" },
      { from: "kolmogorov", to: "house" },
      { from: "console", to: "house" },
      { from: "console", to: "kolmogorov" },
      { from: "yesman", to: "butterbolt" },
      { from: "butterbolt", to: "yesman" },
    ],
    maxBodyChars: 4000,
    rateLimit: { perSenderPerMinute: 1000 },
    threadHopBudget: HOP_BUDGET,
  }),
);

let processOnce, loadThreadState;

function outbox(bot) {
  const d = join(ROOT, bot, "outbox");
  mkdirSync(d, { recursive: true });
  return d;
}
function put(bot, id, env) {
  writeFileSync(join(outbox(bot), `${id}.json`), JSON.stringify({ id, ts: "2026-09-04T10:00:00Z", ...env }));
}
function inboxFiles(bot) {
  const d = join(ROOT, bot, "inbox");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json") && !f.startsWith(".")) : [];
}
function refusedReason(bot, id) {
  const p = join(ROOT, bot, "refused", `${id}.json.reason`);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
// The relay requires ids matching /^m_[0-9a-f]{6,}$/ (envelope.ts's own rule,
// mirrored in the relay). A plain word-ish id like "m_hop1" FAILS that and is
// refused as "invalid" before the hop-budget logic ever runs — mint a valid
// hex id from a readable label instead, so failures stay easy to read.
// MEMOIZED by label: calling mid("hop1") again later (e.g. to build the
// expected inbox filename) must return the SAME id as the first call, not a
// fresh one — this mints an id once per distinct label and remembers it.
const mintedIds = new Map();
let seq = 0;
function mid(label) {
  if (mintedIds.has(label)) return mintedIds.get(label);
  seq += 1;
  const hex = Buffer.from(label).toString("hex").slice(0, 10).padEnd(6, "0");
  const id = `m_${hex}${seq.toString(16).padStart(2, "0")}`;
  mintedIds.set(label, id);
  return id;
}

beforeAll(async () => {
  ({ processOnce, loadThreadState } = await import("../claw-mail-relay.mjs"));
});

describe("thread hop budget (CLAW-090)", () => {
  it("allows exactly HOP_BUDGET bot-authored hops on a thread, then refuses the next", () => {
    const threadId = "t-basic";
    // Hops 1..3 (== HOP_BUDGET): house -> kolmogorov, all should deliver.
    for (let i = 1; i <= HOP_BUDGET; i++) {
      put("house", mid(`hop${i}`), { to: ["kolmogorov"], kind: "dm", subject: "s", body: `hop ${i}`, thread_id: threadId });
      processOnce();
      expect(inboxFiles("kolmogorov"), `hop ${i} should deliver`).toContain(`house__${mid(`hop${i}`)}.json`);
    }
    const state = loadThreadState(ROOT);
    expect(state[threadId]).toMatchObject({ count: HOP_BUDGET, budgetExceeded: false });

    // Hop 4 (budget + 1) must be refused, not delivered.
    put("house", mid("hopOver"), { to: ["kolmogorov"], kind: "dm", subject: "s", body: "one too many", thread_id: threadId });
    processOnce();
    expect(inboxFiles("kolmogorov")).not.toContain(`house__${mid("hopOver")}.json`);
    expect(existsSync(join(ROOT, "house", "refused", `${mid("hopOver")}.json`))).toBe(true);
    expect(refusedReason("house", mid("hopOver"))).toContain("thread hop budget exceeded");
    expect(refusedReason("house", mid("hopOver"))).toContain(threadId);

    const after = loadThreadState(ROOT);
    expect(after[threadId]).toMatchObject({ count: HOP_BUDGET, budgetExceeded: true });
  });

  it("a console-authored message on an over-budget thread is ALWAYS delivered, and resets the count", () => {
    const threadId = "t-console-reset";
    for (let i = 1; i <= HOP_BUDGET; i++) {
      put("house", mid(`resetPre${i}`), { to: ["kolmogorov"], kind: "dm", subject: "s", body: "x", thread_id: threadId });
    }
    processOnce();
    expect(loadThreadState(ROOT)[threadId]).toMatchObject({ count: HOP_BUDGET, budgetExceeded: false });

    // One more bot-authored hop should now be refused (budget already used up).
    put("house", mid("resetOver"), { to: ["kolmogorov"], kind: "dm", subject: "s", body: "blocked", thread_id: threadId });
    processOnce();
    expect(existsSync(join(ROOT, "house", "refused", `${mid("resetOver")}.json`))).toBe(true);
    expect(loadThreadState(ROOT)[threadId].budgetExceeded).toBe(true);

    // Mike's own message on the SAME thread must go through regardless, and reset it.
    put("console", mid("mikeReply"), { to: ["house"], kind: "dm", subject: "s", body: "carry on", thread_id: threadId });
    processOnce();
    expect(inboxFiles("house")).toContain(`console__${mid("mikeReply")}.json`);
    expect(loadThreadState(ROOT)[threadId]).toMatchObject({ count: 0, budgetExceeded: false });

    // And a bot can now use the full budget again on that thread.
    put("kolmogorov", mid("resumed1"), { to: ["house"], kind: "dm", subject: "s", body: "resumed", thread_id: threadId });
    processOnce();
    expect(inboxFiles("house")).toContain(`kolmogorov__${mid("resumed1")}.json`);
    expect(loadThreadState(ROOT)[threadId]).toMatchObject({ count: 1, budgetExceeded: false });
  });

  it("a message with NO thread_id is never subject to the hop budget", () => {
    for (let i = 1; i <= HOP_BUDGET + 5; i++) {
      put("house", mid(`nothread${i}`), { to: ["kolmogorov"], kind: "dm", subject: "s", body: "no thread" });
    }
    processOnce();
    for (let i = 1; i <= HOP_BUDGET + 5; i++) {
      expect(inboxFiles("kolmogorov"), `untracked hop ${i}`).toContain(`house__${mid(`nothread${i}`)}.json`);
    }
  });

  it("an empty-string thread_id is treated the same as no thread_id (never budgeted)", () => {
    for (let i = 1; i <= HOP_BUDGET + 2; i++) {
      put("house", mid(`emptythread${i}`), { to: ["kolmogorov"], kind: "dm", subject: "s", body: "x", thread_id: "" });
    }
    processOnce();
    for (let i = 1; i <= HOP_BUDGET + 2; i++) {
      expect(inboxFiles("kolmogorov")).toContain(`house__${mid(`emptythread${i}`)}.json`);
    }
  });

  it("two different threads track independently — one maxing out does not affect the other", () => {
    for (let i = 1; i <= HOP_BUDGET; i++) {
      put("yesman", mid(`ta${i}`), { to: ["butterbolt"], kind: "dm", subject: "s", body: "a", thread_id: "t-a" });
    }
    processOnce();
    put("yesman", mid("taOver"), { to: ["butterbolt"], kind: "dm", subject: "s", body: "a-over", thread_id: "t-a" });
    processOnce();
    expect(existsSync(join(ROOT, "yesman", "refused", `${mid("taOver")}.json`))).toBe(true);

    // Thread B, same sender/recipient pair, must still have its own fresh budget.
    put("yesman", mid("tb1"), { to: ["butterbolt"], kind: "dm", subject: "s", body: "b", thread_id: "t-b" });
    processOnce();
    expect(inboxFiles("butterbolt")).toContain(`yesman__${mid("tb1")}.json`);
    expect(loadThreadState(ROOT)["t-b"]).toMatchObject({ count: 1, budgetExceeded: false });
    expect(loadThreadState(ROOT)["t-a"]).toMatchObject({ budgetExceeded: true });
  });

  it("thread state persists to threads.json in the standard atomic write-temp-then-rename shape", () => {
    put("house", mid("persist1"), { to: ["kolmogorov"], kind: "dm", subject: "s", body: "x", thread_id: "t-persist" });
    processOnce();
    const raw = JSON.parse(readFileSync(join(ROOT, "threads.json"), "utf8"));
    expect(raw.threads["t-persist"]).toMatchObject({ count: 1, budgetExceeded: false });
    expect(typeof raw.updatedAt).toBe("string");
    expect(existsSync(join(ROOT, "threads.json.tmp"))).toBe(false);
  });
});
