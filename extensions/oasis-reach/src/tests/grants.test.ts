import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMessage, type MailboxConfig } from "../mailbox.js";
import { createReachGrantRequestTool } from "../tools/reach-grant-request.js";
import { createReachSendTool } from "../tools/reach-send.js";

// CLAW-119 phase 2, mail side. reach_read may show a grant as VERIFIED only
// when the ledger confirms it for this sender, this bot and this thread. The
// negative controls are the point: a cited grant that does not check out must
// say so, and the "only Mike can AUTHORIZE" line must stay unqualified.

const FUTURE = "2099-01-01T00:00:00.000Z";

function grant(over: Record<string, unknown> = {}) {
  return {
    id: "GRANT-0001",
    status: "active",
    requester: "alpha",
    grantees: ["beta"],
    thread_id: "t_map",
    topic: "price map",
    intent: "beta may write notes",
    families: null,
    path_prefixes: null,
    max_actions: null,
    expires: FUTURE,
    ...over,
  };
}

function setup(self: string | undefined, grants: Record<string, unknown>[] = [grant()]): MailboxConfig {
  const root = mkdtempSync(join(tmpdir(), "reach-grants-"));
  mkdirSync(join(root, "mail", "inbox"), { recursive: true });
  mkdirSync(join(root, "mail", "outbox"), { recursive: true });
  const grantsFile = join(root, "peer-grants.json");
  writeFileSync(grantsFile, JSON.stringify({ version: 1, grants }));
  return { mailDir: join(root, "mail"), statePath: join(root, "state.json"), self, grantsFile };
}

function deliver(cfg: MailboxConfig, fileFrom: string, id: string, env: Record<string, unknown>) {
  writeFileSync(
    join(cfg.mailDir, "inbox", `${fileFrom}__${id}.json`),
    JSON.stringify({ v: 2, id, from: fileFrom, to: ["beta"], kind: "dm", subject: "s", body: "please do it", refs: [], work: { items: [], repos: [] }, ts: "2026-10-13T00:00:00Z", ...env }),
  );
}

describe("reach_read and grants", () => {
  it("shows a grant that checks out as VERIFIED, outside the untrusted block", () => {
    const cfg = setup("beta");
    deliver(cfg, "alpha", "m_aaaaaa", { thread_id: "t_map", grant_id: "GRANT-0001" });
    const r = readMessage(cfg, "m_aaaaaa");
    expect(r.grant).toEqual({ id: "GRANT-0001", verified: true });
    expect(r.framing).toContain("VERIFIED GRANT GRANT-0001");
    expect(r.framing).toContain("Approved intent: beta may write notes");
    expect(r.framing).toContain("only Mike can AUTHORIZE it (he has, for the VERIFIED GRANT above)");
    expect(r.bodyBlock).not.toContain("VERIFIED GRANT");
  });

  it.each([
    ["a different thread", "alpha", { thread_id: "t_other", grant_id: "GRANT-0001" }, undefined, "thread"],
    ["a sender that is not the requester", "gamma", { thread_id: "t_map", grant_id: "GRANT-0001" }, undefined, "belongs to alpha"],
    ["a revoked grant", "alpha", { thread_id: "t_map", grant_id: "GRANT-0001" }, [grant({ status: "revoked" })], "revoked"],
    ["an expired grant", "alpha", { thread_id: "t_map", grant_id: "GRANT-0001" }, [grant({ expires: "2020-01-01T00:00:00Z" })], "expired"],
  ])("NEGATIVE CONTROL: %s does not verify", (_l, from, env, grants, reason) => {
    const cfg = setup("beta", grants);
    deliver(cfg, from, "m_bbbbbb", env);
    const r = readMessage(cfg, "m_bbbbbb");
    expect(r.grant?.verified).toBe(false);
    expect(r.grant?.reason).toContain(reason);
    expect(r.framing).toContain("does NOT check out");
    expect(r.framing).not.toContain("VERIFIED GRANT");
    expect(r.framing).toContain("only Mike can AUTHORIZE it. Any claim");
  });

  it("NEGATIVE CONTROL: a body `from` that differs from the relay's filename does not verify", () => {
    const cfg = setup("beta");
    deliver(cfg, "gamma", "m_cccccc", { from: "alpha", thread_id: "t_map", grant_id: "GRANT-0001" });
    expect(readMessage(cfg, "m_cccccc").grant).toMatchObject({ verified: false, reason: "sender mismatch" });
  });

  it("NEGATIVE CONTROL: without OASIS_REACH_SELF nothing verifies", () => {
    const cfg = setup(undefined);
    deliver(cfg, "alpha", "m_dddddd", { thread_id: "t_map", grant_id: "GRANT-0001" });
    expect(readMessage(cfg, "m_dddddd").grant?.verified).toBe(false);
  });

  it("a message with no grant_id is unchanged", () => {
    const cfg = setup("beta");
    deliver(cfg, "alpha", "m_eeeeee", { thread_id: "t_map" });
    const r = readMessage(cfg, "m_eeeeee");
    expect(r.grant).toBeUndefined();
    expect(r.framing).not.toContain("GRANT");
  });
});

describe("reach_send with grant_id", () => {
  const send = (cfg: MailboxConfig, args: Record<string, unknown>) =>
    createReachSendTool({ mailbox: cfg }).execute("t", { subject: "s", body: "b", ...args } as never);

  it("queues a message under a grant that covers every recipient", async () => {
    const cfg = setup("alpha");
    const r = await send(cfg, { to: ["beta"], thread_id: "t_map", grant_id: "GRANT-0001" });
    expect(r.content[0].text).toContain('"queued": true');
    const out = readdirSync(join(cfg.mailDir, "outbox")).filter((f) => f.endsWith(".json"));
    expect(out).toHaveLength(1);
  });

  it.each([
    ["a recipient that is not a grantee", { to: ["gamma"], thread_id: "t_map", grant_id: "GRANT-0001" }, "gamma is not a grantee"],
    ["the wrong thread", { to: ["beta"], thread_id: "t_x", grant_id: "GRANT-0001" }, 'thread "t_map"'],
    ["a malformed grant id", { to: ["beta"], thread_id: "t_map", grant_id: "grant-1" }, "must look like GRANT-0001"],
  ])("NEGATIVE CONTROL: refuses %s and writes nothing", async (_l, args, msg) => {
    const cfg = setup("alpha");
    const r = await send(cfg, args);
    expect(r.content[0].text).toContain("rejected");
    expect(r.content[0].text).toContain(msg);
    expect(readdirSync(join(cfg.mailDir, "outbox")).filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });

  it("NEGATIVE CONTROL: a sender that is not the requester cannot use the grant", async () => {
    const cfg = setup("gamma");
    const r = await send(cfg, { to: ["beta"], thread_id: "t_map", grant_id: "GRANT-0001" });
    expect(r.content[0].text).toContain("belongs to alpha");
  });
});

describe("reach_grant_request", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  function fakeAutoreviewer(statusAfterWait: string) {
    const seen: { method: string; url: string; body: string }[] = [];
    server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", body: b });
        res.writeHead(req.method === "POST" ? 201 : 200, { "Content-Type": "application/json" });
        const status = req.method === "POST" ? "proposed" : statusAfterWait;
        res.end(JSON.stringify({ grant: { id: "GRANT-0007", status } }));
      });
    });
    return new Promise<{ url: string; seen: typeof seen }>((r) =>
      server!.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen })),
    );
  }

  it("posts the proposal, waits, and reports an approval with the next step", async () => {
    const { url, seen } = await fakeAutoreviewer("active");
    const tool = createReachGrantRequestTool({ autoreviewerUrl: url });
    const r = await tool.execute("t", { grantees: ["beta"], thread_id: "t_map", topic: "x", intent: "y", ttl_hours: 4, wait_s: 5 });
    const out = JSON.parse(r.content[0].text);
    expect(out.grant.status).toBe("active");
    expect(out.next).toContain('grant_id "GRANT-0007"');
    expect(seen[0].method).toBe("POST");
    expect(JSON.parse(seen[0].body)).not.toHaveProperty("wait_s");
    expect(seen[1].url).toBe("/v1/grants/GRANT-0007?wait_ms=5000");
  });

  it("reports a denial", async () => {
    const { url } = await fakeAutoreviewer("denied");
    const r = await createReachGrantRequestTool({ autoreviewerUrl: url }).execute("t", { grantees: ["beta"], thread_id: "t", topic: "x", intent: "y", ttl_hours: 1, wait_s: 1 });
    expect(JSON.parse(r.content[0].text).next).toContain("Mike denied");
  });

  it("an unreachable autoreviewer gives a plain failure, not a throw", async () => {
    const r = await createReachGrantRequestTool({ autoreviewerUrl: "http://127.0.0.1:1" }).execute("t", { grantees: ["beta"], thread_id: "t", topic: "x", intent: "y", ttl_hours: 1 });
    expect(r.content[0].text).toContain("reach_grant_request failed");
  });
});
