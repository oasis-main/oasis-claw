import fs from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_DENY_DIRS,
  DEFAULT_DENY_GLOBS,
  DEFAULT_SEARCH_LIMITS,
  type SearchConfig,
} from "./src/search.js";
import { createFsGlobTool } from "./src/tools/fs-glob.js";
import { createFsGrepTool } from "./src/tools/fs-grep.js";
import { createFsHelpTool } from "./src/tools/fs-help.js";

// Must mirror openclaw.plugin.json configSchema field-for-field. A mismatch
// here crash-loops the whole fleet at boot — that is not hypothetical, it
// happened on 2026-07-30 when oasis-reach's manifest omitted `enabled`.
const configSchema = z.object({
  enabled: z.boolean().optional(),
  roots: z.array(z.string()).optional(),
  denyGlobs: z.array(z.string()).optional(),
  denyDirs: z.array(z.string()).optional(),
  maxResults: z.number().optional(),
  maxFileBytes: z.number().optional(),
  maxMatchesPerFile: z.number().optional(),
  maxScannedFiles: z.number().optional(),
});

const plugin = {
  id: "oasis-find",
  name: "Oasis Find",
  description:
    "Cheap, root-confined filesystem search for agents: fs_glob (find by name), " +
    "fs_grep (find by content), fs_help (which search tool to use when).",

  configSchema: {
    parse(raw: unknown) {
      return configSchema.parse(raw ?? {});
    },
  },

  register(api: OpenClawPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig ?? {});

    // Gate on ENV, not cfg.enabled. The agent tool set is resolved in a FRESH
    // plugin-load context that does NOT thread plugins.entries.<id>.config, so
    // a cfg-only gate leaves the tools registered but unusable (CLAW-076).
    const envRoots = (process.env.OASIS_FIND_ROOTS ?? "")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    const roots = (envRoots.length ? envRoots : (cfg.roots ?? []))
      // Only roots that actually exist in THIS container. A stale path in the
      // env would otherwise make every search silently return nothing.
      .filter((r) => {
        try {
          return fs.statSync(r).isDirectory();
        } catch {
          return false;
        }
      });

    if (roots.length === 0) {
      api.logger.info("oasis-find DISABLED (no readable roots in OASIS_FIND_ROOTS)");
      return;
    }

    const search: SearchConfig = {
      roots,
      denyGlobs: cfg.denyGlobs ?? DEFAULT_DENY_GLOBS,
      denyDirs: cfg.denyDirs ?? DEFAULT_DENY_DIRS,
      maxResults: cfg.maxResults ?? DEFAULT_SEARCH_LIMITS.maxResults,
      maxFileBytes: cfg.maxFileBytes ?? DEFAULT_SEARCH_LIMITS.maxFileBytes,
      maxMatchesPerFile: cfg.maxMatchesPerFile ?? DEFAULT_SEARCH_LIMITS.maxMatchesPerFile,
      maxScannedFiles: cfg.maxScannedFiles ?? DEFAULT_SEARCH_LIMITS.maxScannedFiles,
    };

    api.registerTool(createFsGlobTool({ search }), { name: "fs_glob" });
    api.registerTool(createFsGrepTool({ search }), { name: "fs_grep" });
    api.registerTool(createFsHelpTool({ roots }), { name: "fs_help" });

    api.logger.info("oasis-find plugin loaded", { roots, denyDirs: search.denyDirs.length });
  },
};

export default plugin;
