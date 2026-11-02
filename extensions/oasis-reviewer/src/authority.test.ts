import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  failClosed,
  mirrorState,
  readAuthorityView,
  resetAuthorityViewCache,
  restrictionBlocks,
  restrictionsInForce,
  useFingerprint,
  type AuthorityView,
} from "./authority.js";
import type { PeerGrant } from "./peer-grants.js";

// ── The reviewer's half of the authority link (step 3 part 2) ────────────────
// Load-bearing: a view only tightens; a missing, broken or older view after a
// good one keeps the good one (fail static); expiry is checked here; and the
// grant fingerprint is the same hash that scripts/claw-authority.mjs makes
// (scripts/tests/claw-authority-sync.test.mjs pins the same two values).

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-reviewer-authority-"));
const file = path.join(tmp, "authority.json");
const NOW = Date.parse("2026-11-02T20:00:00.000Z");

function view(over: { seq?: number; items?: unknown[]; grants?: Record<string, unknown>; grantMode?: string } = {}): AuthorityView {
  return {
    v: 1,
    bot: "beta",
    at: new Date(NOW).toISOString(),
    restrictions: { seq: over.seq ?? 3, head: "h", items: (over.items ?? []) as AuthorityView["restrictions"]["items"] },
    ledger: { seq: 5, head: "l", grantMode: (over.grantMode ?? "observe") as "observe", grants: (over.grants ?? {}) as AuthorityView["ledger"]["grants"] },
  };
}

let tick = 0;
function put(v: unknown) {
  fs.writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v));
  const t = new Date(NOW + ++tick * 1000);
  fs.utimesSync(file, t, t);
}

const item = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  target: "agent:beta",
  level: "chat-only",
  trigger: "mike",
  byRoot: true,
  at: "2026-11-02T19:00:00.000Z",
  expiresAt: null,
  reason: "frozen by Mike",
  mode: "enforce",
  ...over,
});

beforeEach(() => {
  resetAuthorityViewCache();
  fs.rmSync(file, { force: true });
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("reading the view", () => {
  it("no file and no earlier view: no restrictions and no fault (the hub is not deployed)", () => {
    expect(readAuthorityView(file)).toEqual({ view: null, fault: null });
  });

  it("FAIL STATIC: a file that is gone after a good view keeps the good view", () => {
    put(view({ items: [item()] }));
    expect(readAuthorityView(file).view?.restrictions.items).toHaveLength(1);
    fs.rmSync(file);
    const r = readAuthorityView(file);
    expect(r.view?.restrictions.items).toHaveLength(1);
    expect(r.fault).toContain("gone");
  });

  it("FAIL STATIC: a file that does not parse keeps the good view", () => {
    put(view({ items: [item()] }));
    readAuthorityView(file);
    put("{ not json");
    const r = readAuthorityView(file);
    expect(r.view?.restrictions.items).toHaveLength(1);
    expect(r.fault).toContain("does not read");
  });

  it("ROLLBACK: an older log (lower seq) keeps the good view, so a replayed old view cannot lift a restriction", () => {
    put(view({ seq: 4, items: [item()] }));
    readAuthorityView(file);
    put(view({ seq: 2, items: [] }));
    const r = readAuthorityView(file);
    expect(r.view?.restrictions.seq).toBe(4);
    expect(r.fault).toContain("older log");
  });

  it("a newer view replaces the old one, including a lift", () => {
    put(view({ seq: 4, items: [item()] }));
    readAuthorityView(file);
    put(view({ seq: 5, items: [] }));
    expect(readAuthorityView(file)).toMatchObject({ view: { restrictions: { seq: 5, items: [] } }, fault: null });
  });
});

describe("levels in force", () => {
  it("takes the strongest enforce level and keeps shadow items apart", () => {
    const f = restrictionsInForce(
      view({
        items: [
          item({ id: "a", level: "fail-closed" }),
          item({ id: "b", level: "chat-only" }),
          item({ id: "c", level: "chat-only" }),
          item({ id: "d", level: "read-only", mode: "shadow", trigger: "count-rule", byRoot: false }),
        ],
      }),
      NOW,
    );
    expect(f).toMatchObject({ level: "chat-only", ids: ["b", "c"], shadowLevel: "read-only", shadowIds: ["d"] });
  });

  it("checks expiry with the local clock; an end time that does not parse never loosens", () => {
    const v = view({
      items: [
        item({ id: "old", level: "stopped", expiresAt: "2026-11-02T19:59:00.000Z" }),
        item({ id: "bad", level: "fail-closed", expiresAt: "not a time" }),
      ],
    });
    expect(restrictionsInForce(v, NOW)).toMatchObject({ level: "fail-closed", ids: ["bad"] });
  });

  it("an unknown level is ignored", () => {
    expect(restrictionsInForce(view({ items: [item({ level: "everything" })] }), NOW).level).toBeNull();
  });
});

describe("what each level blocks", () => {
  const exec = (command: string) => ({ toolName: "exec", family: "exec", command });
  it("stopped blocks everything, report_injection too", () => {
    expect(restrictionBlocks("stopped", { toolName: "report_injection", family: "other" })).toContain("stopped");
  });
  it("chat-only blocks every tool except report_injection", () => {
    expect(restrictionBlocks("chat-only", { toolName: "read", family: "file" })).toContain("only chat");
    expect(restrictionBlocks("chat-only", { toolName: "reach_send", family: "other" })).toContain("only chat");
    expect(restrictionBlocks("chat-only", { toolName: "report_injection", family: "other" })).toBeNull();
  });
  it("read-only lets inert reads through to review and blocks the rest", () => {
    expect(restrictionBlocks("read-only", { toolName: "read", family: "file" })).toBeNull();
    expect(restrictionBlocks("read-only", exec("git status"))).toBeNull();
    expect(restrictionBlocks("read-only", exec("rm -rf /tmp/x"))).toContain("read-only");
    expect(restrictionBlocks("read-only", { toolName: "write", family: "file" })).toContain("read-only");
    expect(restrictionBlocks("read-only", { toolName: "web_fetch", family: "web" })).toContain("read-only");
  });
  it("fail-closed blocks nothing before review", () => {
    expect(restrictionBlocks("fail-closed", exec("rm -rf /tmp/x"))).toBeNull();
    expect(restrictionBlocks(null, exec("rm -rf /tmp/x"))).toBeNull();
  });
  it("fail-closed denies an escalate and a downgraded allow, and keeps a plain allow or deny", () => {
    expect(failClosed({ verdict: "escalate", principle: "hard:x", reason: "push" })?.verdict).toBe("deny");
    for (const p of ["hard:x+peer-grant", "hard:x+operator-consent", "hard:x+unattended-downgrade"]) {
      expect(failClosed({ verdict: "allow", principle: p, reason: "" })?.principle).toBe("authority:fail-closed");
    }
    expect(failClosed({ verdict: "allow", principle: "hard:default-allow", reason: "" })).toBeNull();
    expect(failClosed({ verdict: "deny", principle: "hard:secret", reason: "" })).toBeNull();
  });
});

describe("the grant mirror", () => {
  const g = {
    id: "GRANT-0001",
    status: "active",
    requester: "alpha",
    grantees: ["beta"],
    thread_id: "t_map",
    topic: "price map",
    intent: "beta may write notes",
    families: ["file"],
    path_prefixes: null,
    max_actions: 3,
    approved_at: "2026-11-02T20:00:00.000Z",
    expires: "2026-11-03T20:00:00.000Z",
    card: { chat: 1 },
    reminded: false,
  };
  const d = {
    id: "DIR-0007",
    kind: "directive",
    status: "active",
    requester: "mike",
    grantees: ["house"],
    thread_id: null,
    lane: "CLAW-1",
    topic: "goal ü",
    intent: "may",
    must_not: "push",
    families: null,
    path_prefixes: ["/reach/x"],
    max_actions: null,
    approved_at: "2026-11-02T20:00:00.000Z",
    expires: "2026-11-09T20:00:00.000Z",
    requested_ttl_hours: 0.5,
  };

  it("the fingerprint is the hub's (the same two values are pinned in claw-authority-sync.test.mjs)", () => {
    expect(useFingerprint(g)).toBe("00fa89320dae3e71b99b4effbbdcce0de2f209de56abeee3920abc49fbe4f57c");
    expect(useFingerprint(d)).toBe("77b5cf49904da6941696fea22c5cf45ff7ee88633a7f29f5f33d0be73f25b5e8");
  });

  it("ok, missing, changed and anomaly", () => {
    const grant = g as unknown as PeerGrant;
    expect(mirrorState(view(), grant)).toBe("missing");
    expect(mirrorState(view({ grants: { [g.id]: { use: useFingerprint(g), legal: true, anomaly: null } } }), grant)).toBe("ok");
    const longer = { ...g, expires: "2027-01-01T00:00:00.000Z" } as unknown as PeerGrant;
    expect(mirrorState(view({ grants: { [g.id]: { use: useFingerprint(g), legal: true, anomaly: null } } }), longer)).toBe("changed");
    expect(mirrorState(view({ grants: { [g.id]: { use: useFingerprint(g), legal: false, anomaly: "x" } } }), grant)).toBe("anomaly");
  });
});
