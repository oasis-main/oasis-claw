import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDeepSearchTool } from "../tools/deep-search.js";
import { createFsGlobTool } from "../tools/fs-glob.js";
import { createFsGrepTool } from "../tools/fs-grep.js";
import { createFsHelpTool } from "../tools/fs-help.js";
import { DEFAULT_DENY_DIRS, DEFAULT_DENY_GLOBS, DEFAULT_SEARCH_LIMITS } from "../search.js";

/**
 * Guard against the two failure modes that have actually bitten this fleet.
 *
 * 1. A syntax error in ONE tool file stops the WHOLE plugin from loading, and
 *    every other test still passes because none of them import that file. That
 *    is exactly what a stray backtick in oasis-reach's help tool did — the
 *    image built, the manifest validated, and the tools were simply gone. The
 *    "[tools] allowlist contains unknown entries" warning did NOT appear; that
 *    warning is unreliable in both directions. So: import every tool module.
 *
 * 2. A tool registered in index.ts but missing from the manifest's
 *    contracts.tools is silently never exposed to the agent (CLAW-076). So:
 *    assert the two lists are equal.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "../..");

const search = {
  roots: [pluginRoot],
  denyGlobs: DEFAULT_DENY_GLOBS,
  denyDirs: DEFAULT_DENY_DIRS,
  ...DEFAULT_SEARCH_LIMITS,
};

describe("module load + manifest contract", () => {
  it("every tool module imports and builds a well-formed tool", () => {
    const tools = [
      createFsGlobTool({ search }),
      createFsGrepTool({ search }),
      createFsHelpTool({ roots: search.roots }),
      createDeepSearchTool({ search }),
    ];
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.description.length).toBeGreaterThan(40);
      expect(typeof tool.execute).toBe("function");
      expect(tool.parameters).toBeTruthy();
    }
  });

  it("registered tool names EQUAL manifest contracts.tools", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "utf8"),
    );
    const registered = [
      createFsGlobTool({ search }).name,
      createFsGrepTool({ search }).name,
      createFsHelpTool({ roots: search.roots }).name,
      createDeepSearchTool({ search }).name,
    ].sort();
    expect([...manifest.contracts.tools].sort()).toEqual(registered);
  });

  it("manifest configSchema mirrors the zod fields in index.ts", () => {
    // A manifest/zod mismatch crash-loops the fleet at boot (2026-07-30).
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "utf8"),
    );
    const indexSrc = fs.readFileSync(path.join(pluginRoot, "index.ts"), "utf8");
    for (const key of Object.keys(manifest.configSchema.properties)) {
      expect(indexSrc).toContain(`${key}:`);
    }
  });

  it("fs_help contains no backtick — one killed the reach plugin outright", () => {
    const src = fs.readFileSync(path.join(pluginRoot, "src/tools/fs-help.ts"), "utf8");
    const literal = src.slice(src.indexOf("const text = ["), src.indexOf("].join(\"\\n\")"));
    expect(literal).not.toContain("`");
  });

  it("fs_help actually renders and names the roots it was given", async () => {
    const out = await createFsHelpTool({ roots: ["/reach/demo"] }).execute();
    const text = out.content[0].text;
    expect(text).toContain("/reach/demo");
    expect(text).toContain("fs_glob");
    expect(text).toContain("fs_grep");
    expect(text).toContain("memory_search");
    expect(text).toContain("swarm_read");
  });
});
