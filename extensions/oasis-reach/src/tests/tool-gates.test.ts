import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ── Both tool gates name every registered tool (CLAW-119, 2026-10-13) ────────
// A registerTool'd plugin tool reaches the agent only if (1) the manifest lists
// it under contracts.tools and (2) the runtime entrypoint re-admits it past
// tools.profile="coding" via REACH_TOOLS. reach_grant_request shipped with
// neither, every unit test passed, and House answered "I have no
// reach_grant_request tool" on the first live test. This compares the three
// lists, so a new tool cannot ship with only one of them.

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "..", "..");
const repoRoot = join(pluginRoot, "..", "..");

function registered(): string[] {
  const src = readFileSync(join(pluginRoot, "index.ts"), "utf8");
  return [...src.matchAll(/registerTool\([\s\S]*?\{\s*name:\s*"([a-z_]+)",?\s*\}/g)].map((m) => m[1]).sort();
}

describe("oasis-reach tool gates", () => {
  it("manifest contracts.tools == registered tools", () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, "openclaw.plugin.json"), "utf8"));
    expect([...manifest.contracts.tools].sort()).toEqual(registered());
  });

  it("entrypoint REACH_TOOLS == registered tools", () => {
    const sh = readFileSync(join(repoRoot, "scripts", "runtime-entrypoint.sh"), "utf8");
    const m = /^REACH_TOOLS = \(([^)]*)\)/m.exec(sh);
    expect(m).not.toBeNull();
    const listed = [...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort();
    expect(listed).toEqual(registered());
  });

  it("registered() finds the tools (guards the regex itself)", () => {
    expect(registered()).toContain("reach_grant_request");
    expect(registered().length).toBeGreaterThanOrEqual(6);
  });
});
