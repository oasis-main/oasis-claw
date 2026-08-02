import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";

// Own ROOT + routes so this file's module instance is independent of the routing
// test (vitest isolates modules per test file, so a fresh import picks up this
// file's env).
const ROOT = mkdtempSync(join(tmpdir(), "mailret-"));
const ROUTES = join(ROOT, "routes.json");
process.env.CLAW_MAIL_ROOT = ROOT;
process.env.CLAW_MAIL_ROUTES = ROUTES;

// liveReadDays:0 → a read message archives as soon as it is any age. maxUnreadDays
// huge → unread mail is never touched (invariant under test).
writeFileSync(
  ROUTES,
  JSON.stringify({
    routes: [{ from: "house", to: "kolmogorov" }],
    retention: { liveReadDays: 0, maxUnreadDays: 99999, sweepIntervalMs: 0, gzipClosedMonths: true },
  }),
);

let processReceipts, loadReadSet, sweepRetention, loadRoutes;

function inboxDir(bot) {
  const d = join(ROOT, bot, "inbox");
  mkdirSync(d, { recursive: true });
  return d;
}
function outboxDir(bot) {
  const d = join(ROOT, bot, "outbox");
  mkdirSync(d, { recursive: true });
  return d;
}
function seedInbox(bot, from, id, ts) {
  writeFileSync(join(inboxDir(bot), `${from}__${id}.json`), JSON.stringify({ id, from, to: [bot], kind: "dm", subject: "s", body: "b", refs: [], work: { items: [], repos: [] }, thread_id: "", ts }));
}
function inboxIds(bot) {
  const d = join(ROOT, bot, "inbox");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json") && !f.startsWith(".")) : [];
}
function archiveFiles(bot) {
  const d = join(ROOT, bot, "archive");
  return existsSync(d) ? readdirSync(d) : [];
}

beforeAll(async () => {
  ({ processReceipts, loadReadSet, sweepRetention, loadRoutes } = await import("../claw-mail-relay.mjs"));
});

describe("read receipts", () => {
  it("records ids from a _receipt_ file into the host-side read set and deletes it", () => {
    const rc = join(outboxDir("kolmogorov"), "_receipt_abc123.json");
    writeFileSync(rc, JSON.stringify({ type: "read_receipt", ids: ["m_r0000001", "m_r0000002"], ts: "2026-08-02T10:00:00Z" }));
    processReceipts(ROOT, "kolmogorov");
    const set = loadReadSet(ROOT, "kolmogorov");
    expect(set.has("m_r0000001")).toBe(true);
    expect(set.has("m_r0000002")).toBe(true);
    expect(existsSync(rc)).toBe(false); // consumed
  });
});

describe("retention sweep", () => {
  it("archives READ+old mail out of the live inbox but leaves UNREAD mail in place", () => {
    seedInbox("kolmogorov", "house", "m_read0001", "2026-06-15T10:00:00Z");
    seedInbox("kolmogorov", "house", "m_unrd0001", "2026-06-15T10:00:00Z");
    // Mark only the first read via a receipt.
    writeFileSync(join(outboxDir("kolmogorov"), "_receipt_r2.json"), JSON.stringify({ type: "read_receipt", ids: ["m_read0001"], ts: "2026-08-02T10:00:00Z" }));
    processReceipts(ROOT, "kolmogorov");

    sweepRetention(loadRoutes());

    const remaining = inboxIds("kolmogorov");
    expect(remaining.some((f) => f.includes("m_read0001"))).toBe(false); // archived
    expect(remaining.some((f) => f.includes("m_unrd0001"))).toBe(true); // untouched (unread)

    // The archived envelope is preserved in a shard (gzipped for the closed month).
    const shards = archiveFiles("kolmogorov");
    expect(shards.length).toBeGreaterThan(0);
    const gz = shards.find((f) => f.endsWith(".jsonl.gz"));
    expect(gz).toBeTruthy();
    const text = gunzipSync(readFileSync(join(ROOT, "kolmogorov", "archive", gz))).toString("utf8");
    expect(text).toContain("m_read0001");
    expect(text).toContain('"_wasRead":true');
  });
});
