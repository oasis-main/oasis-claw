import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newMessageId, validateOutbound, type MailKind } from "../envelope.js";
import { listInbox, markAllRead, readCorpus, readMessage, threadMessages, unreadCount, writeOutbound, type MailboxConfig } from "../mailbox.js";

function tempMailbox(): MailboxConfig {
  const root = mkdtempSync(join(tmpdir(), "reach-"));
  mkdirSync(join(root, "mail", "inbox"), { recursive: true });
  mkdirSync(join(root, "mail", "outbox"), { recursive: true });
  mkdirSync(join(root, "mail", "archive"), { recursive: true });
  mkdirSync(join(root, "mail", "sent"), { recursive: true });
  return {
    mailDir: join(root, "mail"),
    statePath: join(root, "state", "reach-read.json"),
    archiveDir: join(root, "mail", "archive"),
    sentDir: join(root, "mail", "sent"),
  };
}

function seedSent(cfg: MailboxConfig, id: string, to: string, subject: string, body: string, ts: string): void {
  const env = { id, to: [to], kind: "dm", subject, body, refs: [], work: { items: [], repos: [] }, thread_id: "", ts };
  writeFileSync(join(cfg.mailDir, "sent", `${id}.json`), JSON.stringify(env));
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

describe("conversation view (reach_thread) — the 'inbox is empty' regression", () => {
  it("REGRESSION: a peer reply already marked READ is still visible in the thread", () => {
    // Exactly the 2026-08-05 live failure: a background wake read House's reply, so
    // reach_inbox{unread_only:true} returned nothing and the bot said "inbox empty".
    const cfg = tempMailbox();
    seedInbox(cfg, "house", "m_th0001", "Re: proposal", "House's substantive reply", "2026-08-05T15:34:33Z");
    readMessage(cfg, "m_th0001"); // background wake marks it read
    expect(unreadCount(cfg)).toBe(0); // unread view: nothing — the misleading signal
    const thread = threadMessages(cfg, { peer: "house" });
    expect(thread.map((m) => m.id)).toContain("m_th0001"); // history view: still there
    expect(thread[0].direction).toBe("in");
  });

  it("shows BOTH directions with a peer, oldest first", () => {
    const cfg = tempMailbox();
    seedSent(cfg, "m_th0010", "house", "proposal", "my outgoing ask", "2026-08-05T15:33:00Z");
    seedInbox(cfg, "house", "m_th0011", "Re: proposal", "his answer", "2026-08-05T15:34:00Z");
    const t = threadMessages(cfg, { peer: "house" });
    expect(t.map((m) => m.id)).toEqual(["m_th0010", "m_th0011"]);
    expect(t.map((m) => m.direction)).toEqual(["out", "in"]);
    expect(t[0].from).toBe("me");
  });

  it("scopes to the requested peer only", () => {
    const cfg = tempMailbox();
    seedInbox(cfg, "house", "m_th0020", "a", "b", "2026-08-05T10:00:00Z");
    seedInbox(cfg, "vanhelsing", "m_th0021", "a", "b", "2026-08-05T11:00:00Z");
    expect(threadMessages(cfg, { peer: "house" }).map((m) => m.id)).toEqual(["m_th0020"]);
  });

  it("returns empty for a peer with no exchange (so the bot can say so truthfully)", () => {
    const cfg = tempMailbox();
    expect(threadMessages(cfg, { peer: "nobody" })).toHaveLength(0);
  });
});

// readCorpus backs reach_thread (recall) and, indirectly, the CLAW-082 phase 4
// mail corpus (a separate host-side script reads the same raw files and derives
// a searchable markdown copy — reach_search's ranking layer was retired once
// memory_search + fs_grep could search that derived corpus directly).
describe("search corpus", () => {
  it("reads both the live inbox and archive shards (plain + gzip), de-duped", () => {
    const cfg = tempMailbox();
    seedInbox(cfg, "house", "m_live001", "live one", "current inbox body", "2026-08-02T10:00:00Z");
    seedArchiveShard(cfg, "2026-06", [{ id: "m_arch001", from: "house", kind: "dm", subject: "old plain", body: "archived plain", refs: [], work: { items: [], repos: [] }, ts: "2026-06-15T10:00:00Z" }]);
    seedArchiveShard(cfg, "2026-05", [{ id: "m_arch002", from: "house", kind: "dm", subject: "old gz", body: "archived gzip", refs: [], work: { items: [], repos: [] }, ts: "2026-05-15T10:00:00Z" }], true);
    const ids = readCorpus(cfg).map((m) => m.id).sort();
    expect(ids).toEqual(["m_arch001", "m_arch002", "m_live001"]);
  });
});

afterEach(() => {
  /* temp dirs are under the OS tmp; left for the OS to reap */
});
