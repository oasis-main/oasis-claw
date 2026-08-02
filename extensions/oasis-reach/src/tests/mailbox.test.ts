import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newMessageId, validateOutbound, type MailKind } from "../envelope.js";
import { listInbox, markAllRead, rankCorpus, readCorpus, readMessage, unreadCount, writeOutbound, type MailboxConfig } from "../mailbox.js";

function tempMailbox(): MailboxConfig {
  const root = mkdtempSync(join(tmpdir(), "reach-"));
  mkdirSync(join(root, "mail", "inbox"), { recursive: true });
  mkdirSync(join(root, "mail", "outbox"), { recursive: true });
  mkdirSync(join(root, "mail", "archive"), { recursive: true });
  return { mailDir: join(root, "mail"), statePath: join(root, "state", "reach-read.json"), archiveDir: join(root, "mail", "archive") };
}

function seedInbox(
  cfg: MailboxConfig,
  from: string,
  id: string,
  subject: string,
  body: string,
  ts: string,
  work: { items: string[]; repos: string[] } = { items: [], repos: [] },
): void {
  const env = { id, from, to: ["me"], kind: "dm", subject, body, refs: [], work, thread_id: "", ts };
  writeFileSync(join(cfg.mailDir, "inbox", `${from}__${id}.json`), JSON.stringify(env));
}

function seedArchiveShard(cfg: MailboxConfig, month: string, envs: Record<string, unknown>[], gz = false): void {
  const text = envs.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const name = `${month}.jsonl${gz ? ".gz" : ""}`;
  writeFileSync(join(cfg.archiveDir!, name), gz ? gzipSync(Buffer.from(text)) : text);
}

describe("envelope validation", () => {
  it("accepts a well-formed outbound envelope", () => {
    const env = { id: newMessageId(), to: ["kolmogorov"], kind: "dm" as MailKind, subject: "hi", body: "hello", refs: [], thread_id: "", ts: new Date().toISOString() };
    expect(validateOutbound(env).ok).toBe(true);
  });

  it("rejects empty recipients, bad kind, oversize body, and non-key recipients", () => {
    expect(validateOutbound({ id: newMessageId(), to: [], kind: "dm", subject: "", body: "", refs: [], thread_id: "", ts: "t" }).ok).toBe(false);
    expect(validateOutbound({ id: newMessageId(), to: ["x"], kind: "gossip", subject: "", body: "", refs: [], thread_id: "", ts: "t" }).ok).toBe(false);
    expect(validateOutbound({ id: newMessageId(), to: ["x"], kind: "dm", subject: "", body: "z".repeat(20000), refs: [], thread_id: "", ts: "t" }).ok).toBe(false);
    expect(validateOutbound({ id: newMessageId(), to: ["Not A Key"], kind: "dm", subject: "", body: "", refs: [], thread_id: "", ts: "t" }).ok).toBe(false);
  });
});

describe("mailbox round-trip", () => {
  it("lists newest-first and counts unread", () => {
    const cfg = tempMailbox();
    seedInbox(cfg, "house", "m_aaa111", "older", "b1", "2026-07-30T10:00:00Z");
    seedInbox(cfg, "house", "m_bbb222", "newer", "b2", "2026-07-30T12:00:00Z");
    const items = listInbox(cfg);
    expect(items.map((i) => i.id)).toEqual(["m_bbb222", "m_aaa111"]);
    expect(unreadCount(cfg)).toBe(2);
  });

  it("marks a message read on read and drops the unread count", () => {
    const cfg = tempMailbox();
    seedInbox(cfg, "house", "m_ccc333", "s", "the body", "2026-07-30T10:00:00Z");
    expect(unreadCount(cfg)).toBe(1);
    const r = readMessage(cfg, "m_ccc333");
    expect(r.found).toBe(true);
    expect(unreadCount(cfg)).toBe(0);
  });

  it("wraps the body in nonce-delimited UNTRUSTED markers with peer framing", () => {
    const cfg = tempMailbox();
    seedInbox(cfg, "house", "m_ddd444", "s", "PAYLOAD-TEXT", "2026-07-30T10:00:00Z");
    const r = readMessage(cfg, "m_ddd444");
    expect(r.rendered).toContain("PEER MESSAGE");
    expect(r.rendered).toContain("not from Mike");
    expect(r.rendered).toMatch(/<<<UNTRUSTED_PEER_[0-9a-f]{24}>>>/);
    expect(r.rendered).toMatch(/<<<END_UNTRUSTED_PEER_[0-9a-f]{24}>>>/);
    // The body sits BETWEEN the markers.
    const open = r.rendered!.indexOf("<<<UNTRUSTED_PEER_");
    const payload = r.rendered!.indexOf("PAYLOAD-TEXT");
    const close = r.rendered!.indexOf("<<<END_UNTRUSTED_PEER_");
    expect(open).toBeLessThan(payload);
    expect(payload).toBeLessThan(close);
  });

  it("markAllRead dismisses without rendering and is idempotent", () => {
    const cfg = tempMailbox();
    seedInbox(cfg, "house", "m_eee555", "s", "b", "2026-07-30T10:00:00Z");
    seedInbox(cfg, "house", "m_fff666", "s", "b", "2026-07-30T11:00:00Z");
    expect(markAllRead(cfg)).toBe(2);
    expect(markAllRead(cfg)).toBe(0);
    expect(unreadCount(cfg)).toBe(0);
  });

  it("returns not-found for an unknown id", () => {
    const cfg = tempMailbox();
    expect(readMessage(cfg, "m_nope00").found).toBe(false);
  });
});

describe("outbox write is atomic (no partial files visible to the relay)", () => {
  it("writes a .json final file and leaves no .tmp", () => {
    const cfg = tempMailbox();
    const env = { id: newMessageId(), to: ["kolmogorov"], kind: "dm" as MailKind, subject: "s", body: "b", refs: [], work: { items: [], repos: [] }, thread_id: "", ts: new Date().toISOString() };
    writeOutbound(cfg, env);
    const files = readdirSync(join(cfg.mailDir, "outbox"));
    expect(files).toContain(`${env.id}.json`);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});

describe("work references (.swarm items + repos)", () => {
  it("validates work items and repos, rejecting malformed ones", () => {
    const base = { id: newMessageId(), to: ["kolmogorov"], kind: "dm" as MailKind, subject: "s", body: "b", refs: [], thread_id: "", ts: "t" };
    expect(validateOutbound({ ...base, work: { items: ["CLAW-076"], repos: ["oasis-cloud", "org/repo"] } }).ok).toBe(true);
    expect(validateOutbound({ ...base, work: { items: ["has space"], repos: [] } }).ok).toBe(false);
    expect(validateOutbound({ ...base, work: { items: [], repos: ["bad repo!"] } }).ok).toBe(false);
  });

  it("surfaces work refs in reach_read rendering and inbox listing", () => {
    const cfg = tempMailbox();
    seedInbox(cfg, "house", "m_wk0001", "markets", "body", "2026-07-30T10:00:00Z", { items: ["CLAW-076"], repos: ["oasis-cloud"] });
    expect(listInbox(cfg)[0].work.items).toContain("CLAW-076");
    const r = readMessage(cfg, "m_wk0001");
    expect(r.rendered).toContain("CLAW-076");
    expect(r.work?.repos).toContain("oasis-cloud");
  });
});

describe("read receipts", () => {
  it("emits a _receipt_ file to the outbox on read (for the relay's retention)", () => {
    const cfg = tempMailbox();
    seedInbox(cfg, "house", "m_rc0001", "s", "b", "2026-07-30T10:00:00Z");
    readMessage(cfg, "m_rc0001");
    const receipts = readdirSync(join(cfg.mailDir, "outbox")).filter((f) => f.startsWith("_receipt_"));
    expect(receipts).toHaveLength(1);
  });
});

describe("search corpus + ranking", () => {
  it("reads both the live inbox and archive shards (plain + gzip), de-duped", () => {
    const cfg = tempMailbox();
    seedInbox(cfg, "house", "m_live001", "live one", "current inbox body", "2026-08-02T10:00:00Z");
    seedArchiveShard(cfg, "2026-06", [{ id: "m_arch001", from: "house", kind: "dm", subject: "old plain", body: "archived plain", refs: [], work: { items: [], repos: [] }, ts: "2026-06-15T10:00:00Z" }]);
    seedArchiveShard(cfg, "2026-05", [{ id: "m_arch002", from: "house", kind: "dm", subject: "old gz", body: "archived gzip", refs: [], work: { items: [], repos: [] }, ts: "2026-05-15T10:00:00Z" }], true);
    const ids = readCorpus(cfg).map((m) => m.id).sort();
    expect(ids).toEqual(["m_arch001", "m_arch002", "m_live001"]);
  });

  it("ranks by term overlap, weighting subject and metadata over body", () => {
    const cfg = tempMailbox();
    seedInbox(cfg, "house", "m_rk0001", "transition matrix regime", "off-topic body", "2026-07-30T10:00:00Z");
    seedInbox(cfg, "house", "m_rk0002", "unrelated", "a passing mention of matrix here", "2026-07-30T11:00:00Z");
    const ranked = rankCorpus(cfg, "matrix");
    expect(ranked[0].id).toBe("m_rk0001"); // subject hit outranks body hit
  });

  it("filters by work-item and by sender", () => {
    const cfg = tempMailbox();
    seedInbox(cfg, "house", "m_ft0001", "a", "b", "2026-07-30T10:00:00Z", { items: ["CLAW-076"], repos: [] });
    seedInbox(cfg, "vanhelsing", "m_ft0002", "a", "b", "2026-07-30T11:00:00Z", { items: ["CLAW-099"], repos: [] });
    expect(rankCorpus(cfg, "", { item: "CLAW-076" }).map((m) => m.id)).toEqual(["m_ft0001"]);
    expect(rankCorpus(cfg, "", { from: "vanhelsing" }).map((m) => m.id)).toEqual(["m_ft0002"]);
  });
});

afterEach(() => {
  /* temp dirs are under the OS tmp; left for the OS to reap */
});
