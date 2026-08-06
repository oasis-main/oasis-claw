import { describe, expect, it } from "vitest";

// ── Load smoke test (CLAW-076) ────────────────────────────────────────────────
// WHY THIS EXISTS: on 2026-08-06 a stray backtick inside reach-help.ts's template
// literal was a SYNTAX error. Every unit test still passed (none imported that
// file), the image built, the manifest stayed valid, and the "[tools] allowlist
// contains unknown entries" warning did NOT appear — yet the whole plugin failed
// to load in the container, so EVERY reach_* tool silently vanished from the
// agent and the bot answered "NO_SUCH_TOOL".
//
// A module that never gets imported by a test is a module that can be broken and
// shipped. This imports every tool module AND the plugin entry point, so any
// syntax/import error fails here instead of on a live bot.

describe("every oasis-reach module parses and imports", () => {
  it("loads each tool module and exposes its factory", async () => {
    const mods = await Promise.all([
      import("../tools/reach-send.js"),
      import("../tools/reach-inbox.js"),
      import("../tools/reach-read.js"),
      import("../tools/reach-search.js"),
      import("../tools/reach-thread.js"),
      import("../tools/reach-help.js"),
    ]);
    const factories = [
      mods[0].createReachSendTool,
      mods[1].createReachInboxTool,
      mods[2].createReachReadTool,
      mods[3].createReachSearchTool,
      mods[4].createReachThreadTool,
      mods[5].createReachHelpTool,
    ];
    for (const f of factories) expect(typeof f).toBe("function");
  });

  it("reach_help returns a non-empty guide (the file that broke)", async () => {
    const { createReachHelpTool } = await import("../tools/reach-help.js");
    const res = await createReachHelpTool().execute();
    const text = res.content[0].text;
    expect(text.length).toBeGreaterThan(500);
    expect(text).toContain("reach_thread");
  });

  it("every tool exposes the name + parameters shape openclaw expects", async () => {
    const mailbox = { mailDir: "/tmp/nope", statePath: "/tmp/nope/state.json" };
    const { createReachSendTool } = await import("../tools/reach-send.js");
    const { createReachInboxTool } = await import("../tools/reach-inbox.js");
    const { createReachReadTool } = await import("../tools/reach-read.js");
    const { createReachSearchTool } = await import("../tools/reach-search.js");
    const { createReachThreadTool } = await import("../tools/reach-thread.js");
    const { createReachHelpTool } = await import("../tools/reach-help.js");
    const tools = [
      createReachSendTool({ mailbox }),
      createReachInboxTool({ mailbox }),
      createReachReadTool({ mailbox }),
      createReachSearchTool({ mailbox }),
      createReachThreadTool({ mailbox }),
      createReachHelpTool(),
    ];
    const names = tools.map((t) => t.name).sort();
    // MUST match the manifest's contracts.tools, or the tools never materialize.
    expect(names).toEqual(["reach_help", "reach_inbox", "reach_read", "reach_search", "reach_send", "reach_thread"]);
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect(t.parameters).toBeTruthy();
      expect(typeof t.execute).toBe("function");
    }
  });
});
