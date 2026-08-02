import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type MailboxConfig } from "../mailbox.js";
import { createReachSearchTool } from "../tools/reach-search.js";

function tempMailbox(): MailboxConfig {
  const root = mkdtempSync(join(tmpdir(), "reachsearch-"));
  mkdirSync(join(root, "mail", "inbox"), { recursive: true });
  mkdirSync(join(root, "mail", "archive"), { recursive: true });
  return { mailDir: join(root, "mail"), statePath: join(root, "state.json"), archiveDir: join(root, "mail", "archive") };
}
function seed(cfg: MailboxConfig, id: string, subject: string, body: string): void {
  const env = { id, from: "house", to: ["me"], kind: "dm", subject, body, refs: [], work: { items: ["CLAW-076"], repos: [] }, thread_id: "", ts: "2026-07-30T10:00:00Z" };
  writeFileSync(join(cfg.mailDir, "inbox", `house__${id}.json`), JSON.stringify(env));
}

async function textOf(res: Promise<{ content: { text: string }[] }>): Promise<string> {
  return (await res).content[0].text;
}

describe("reach_search tool", () => {
  it("list mode returns ranked metadata without a model call", async () => {
    const cfg = tempMailbox();
    seed(cfg, "m_s0000001", "transition matrix", "regime shift in risk assets");
    const tool = createReachSearchTool({ mailbox: cfg }); // no complete
    const out = JSON.parse(await textOf(tool.execute("t", { query: "matrix", mode: "list" })));
    expect(out.mode).toBe("list");
    expect(out.results[0].id).toBe("m_s0000001");
    expect(out.results[0].snippet).toBeTruthy();
  });

  it("answer mode calls the model with nonce-delimited UNTRUSTED framing and returns a synthesized answer", async () => {
    const cfg = tempMailbox();
    seed(cfg, "m_s0000002", "markets", "Q3 repricing suggests a regime shift");
    let sawSystem = "";
    let sawUser = "";
    const complete = async (p: { systemPrompt?: string; messages: { content: string }[] }) => {
      sawSystem = p.systemPrompt ?? "";
      sawUser = p.messages[0].content;
      return { text: "A regime shift is likely [m_s0000002]." };
    };
    const tool = createReachSearchTool({ mailbox: cfg, complete });
    const out = JSON.parse(await textOf(tool.execute("t", { query: "what did house say about Q3", mode: "answer" })));
    expect(out.mode).toBe("answer");
    expect(out.answer).toContain("regime shift");
    expect(out.citations[0].id).toBe("m_s0000002");
    // Untrusted framing must be present around the corpus.
    expect(sawSystem).toContain("UNTRUSTED");
    expect(sawUser).toMatch(/<<<UNTRUSTED_MAIL_[0-9a-f]{24}>>>/);
    expect(sawUser).toMatch(/<<<END_UNTRUSTED_MAIL_[0-9a-f]{24}>>>/);
  });

  it("filters by work-item id", async () => {
    const cfg = tempMailbox();
    seed(cfg, "m_s0000003", "a", "b");
    const tool = createReachSearchTool({ mailbox: cfg });
    const hit = JSON.parse(await textOf(tool.execute("t", { query: "", mode: "list", item: "CLAW-076" })));
    expect(hit.matches).toBe(1);
    const miss = JSON.parse(await textOf(tool.execute("t", { query: "", mode: "list", item: "CLAW-999" })));
    expect(miss.matches).toBe(0);
  });

  it("falls back to a list when the model call throws", async () => {
    const cfg = tempMailbox();
    seed(cfg, "m_s0000004", "topic", "body text");
    const complete = async () => {
      throw new Error("model down");
    };
    const tool = createReachSearchTool({ mailbox: cfg, complete });
    const out = JSON.parse(await textOf(tool.execute("t", { query: "topic", mode: "answer" })));
    expect(out.mode).toBe("list(fallback)");
    expect(out.results[0].id).toBe("m_s0000004");
  });
});
