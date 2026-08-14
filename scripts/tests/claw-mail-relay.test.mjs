import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";

// The relay reads CLAW_MAIL_ROOT / CLAW_MAIL_ROUTES at module load, so set them
// BEFORE importing it, then import dynamically.
const ROOT = mkdtempSync(join(tmpdir(), "mailrelay-"));
const ROUTES = join(ROOT, "routes.json");

process.env.CLAW_MAIL_ROOT = ROOT;
process.env.CLAW_MAIL_ROUTES = ROUTES;

writeFileSync(
  ROUTES,
  JSON.stringify({
    routes: [
      { from: "house", to: "kolmogorov" },
      { from: "vanhelsing", to: "kolmogorov" },
      // Two senders reserved for the protocol-version tests at the end of this
      // file. They are kept separate from house/vanhelsing because the rate
      // limiter (perSenderPerMinute: 2) is per-sender and persists across the
      // whole file — reusing an existing sender would silently defer a send and
      // turn a version assertion into a rate-limit failure.
      { from: "butterbolt", to: "kolmogorov" },
      { from: "yesman", to: "kolmogorov" },
    ],
    maxBodyChars: 100,
    rateLimit: { perSenderPerMinute: 2 },
  }),
);

let processOnce;

function outbox(bot) {
  const d = join(ROOT, bot, "outbox");
  mkdirSync(d, { recursive: true });
  return d;
}
function put(bot, id, env) {
  writeFileSync(join(outbox(bot), `${id}.json`), JSON.stringify({ id, ts: "2026-07-30T10:00:00Z", ...env }));
}
function inboxFiles(bot) {
  const d = join(ROOT, bot, "inbox");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json") && !f.startsWith(".")) : [];
}

beforeAll(async () => {
  ({ processOnce } = await import("../claw-mail-relay.mjs"));
});

describe("claw-mail-relay routing", () => {
  it("delivers an allowed route and stamps `from` from the source dir", () => {
    put("house", "m_a01111", { to: ["kolmogorov"], kind: "dm", subject: "s", body: "hello k" });
    processOnce();
    const files = inboxFiles("kolmogorov");
    expect(files).toContain("house__m_a01111.json");
    const env = JSON.parse(readFileSync(join(ROOT, "kolmogorov", "inbox", "house__m_a01111.json"), "utf8"));
    expect(env.from).toBe("house"); // stamped by relay, not from the envelope
  });

  it("refuses a route not in the table (default-deny) and archives it", () => {
    put("kolmogorov", "m_b02222", { to: ["nimbus"], kind: "dm", subject: "s", body: "should not arrive" });
    processOnce();
    expect(inboxFiles("nimbus")).toHaveLength(0);
    expect(existsSync(join(ROOT, "kolmogorov", "refused", "m_b02222.json"))).toBe(true);
  });

  it("cannot spoof `from`: an envelope claiming from=kolmogorov in house/outbox is stamped house", () => {
    put("house", "m_c03333", { from: "kolmogorov", to: ["kolmogorov"], kind: "dm", subject: "s", body: "x" });
    processOnce();
    const env = JSON.parse(readFileSync(join(ROOT, "kolmogorov", "inbox", "house__m_c03333.json"), "utf8"));
    expect(env.from).toBe("house");
  });

  it("refuses an oversize body", () => {
    put("house", "m_d04444", { to: ["kolmogorov"], kind: "dm", subject: "s", body: "z".repeat(200) });
    processOnce();
    expect(inboxFiles("kolmogorov")).not.toContain("house__m_d04444.json");
    expect(existsSync(join(ROOT, "house", "refused", "m_d04444.json"))).toBe(true);
  });

  it("rate-limits: the 3rd send in a window is deferred (left in outbox)", () => {
    // perSenderPerMinute=2. Two already consumed above for house (route1 + spoof;
    // big was refused pre-rate? no — rate is checked before recipients, after
    // validation). Use a fresh sender window is hard to guarantee, so assert the
    // deferral mechanism directly: queue 3 valid sends from a fresh bot.
    for (const id of ["m_e05551", "m_e05552", "m_e05553"]) put("vanhelsing", id, { to: ["kolmogorov"], kind: "dm", subject: "s", body: "b" });
    processOnce();
    // 2 delivered, 1 still sitting in the outbox (deferred, not dropped).
    const remaining = readdirSync(join(ROOT, "vanhelsing", "outbox")).filter((f) => f.endsWith(".json") && !f.startsWith("."));
    expect(remaining).toHaveLength(1);
  });
});

// ── Protocol version (CLAW-088 §2.2) ──────────────────────────────────────────
// `put()` above always writes an `id` and `ts` and spreads the caller's fields,
// so an envelope with no `v` here is exactly the pre-2026-08-12 wire format that
// is still sitting in live outboxes and archive shards.
describe("claw-mail-relay protocol version", () => {
  it("accepts an envelope with NO version field (absent means 1, back-compat)", () => {
    put("butterbolt", "m_f06001", { to: ["kolmogorov"], kind: "dm", subject: "s", body: "no v" });
    processOnce();
    expect(inboxFiles("kolmogorov")).toContain("butterbolt__m_f06001.json");
  });

  it("accepts v=1 and carries the version through to the delivered copy", () => {
    put("yesman", "m_f06002", { v: 1, to: ["kolmogorov"], kind: "dm", subject: "s", body: "v1" });
    processOnce();
    const env = JSON.parse(readFileSync(join(ROOT, "kolmogorov", "inbox", "yesman__m_f06002.json"), "utf8"));
    expect(env.v).toBe(1);
    expect(env.from).toBe("yesman");
  });

  it("refuses a FUTURE protocol version rather than guessing at it", () => {
    put("butterbolt", "m_f06003", { v: 2, to: ["kolmogorov"], kind: "dm", subject: "s", body: "from the future" });
    processOnce();
    expect(inboxFiles("kolmogorov")).not.toContain("butterbolt__m_f06003.json");
    expect(existsSync(join(ROOT, "butterbolt", "refused", "m_f06003.json"))).toBe(true);
  });

  it("refuses a non-integer version", () => {
    put("yesman", "m_f06004", { v: "1", to: ["kolmogorov"], kind: "dm", subject: "s", body: "string version" });
    put("yesman", "m_f06005", { v: 1.5, to: ["kolmogorov"], kind: "dm", subject: "s", body: "float version" });
    processOnce();
    expect(existsSync(join(ROOT, "yesman", "refused", "m_f06004.json"))).toBe(true);
    expect(existsSync(join(ROOT, "yesman", "refused", "m_f06005.json"))).toBe(true);
  });
});
