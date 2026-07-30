import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newMessageId, validateOutbound, type MailKind } from "../envelope.js";
import { listInbox, markAllRead, readMessage, unreadCount, writeOutbound, type MailboxConfig } from "../mailbox.js";

function tempMailbox(): MailboxConfig {
  const root = mkdtempSync(join(tmpdir(), "reach-"));
  mkdirSync(join(root, "mail", "inbox"), { recursive: true });
  mkdirSync(join(root, "mail", "outbox"), { recursive: true });
  return { mailDir: join(root, "mail"), statePath: join(root, "state", "reach-read.json") };
}

function seedInbox(cfg: MailboxConfig, from: string, id: string, subject: string, body: string, ts: string): void {
  const env = { id, from, to: ["me"], kind: "dm", subject, body, refs: [], thread_id: "", ts };
  writeFileSync(join(cfg.mailDir, "inbox", `${from}__${id}.json`), JSON.stringify(env));
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
    const env = { id: newMessageId(), to: ["kolmogorov"], kind: "dm" as MailKind, subject: "s", body: "b", refs: [], thread_id: "", ts: new Date().toISOString() };
    writeOutbound(cfg, env);
    const files = readdirSync(join(cfg.mailDir, "outbox"));
    expect(files).toContain(`${env.id}.json`);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});

afterEach(() => {
  /* temp dirs are under the OS tmp; left for the OS to reap */
});
