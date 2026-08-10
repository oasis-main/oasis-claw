import path from "node:path";
import { globToRegExp, resolveInsideRoots, walkFiles, type SearchConfig } from "../search.js";

export interface FsGlobConfig {
  search: SearchConfig;
}

/**
 * fs_glob — find files by NAME. The cheap half of situational awareness: it
 * answers "where does X live" without reading a single file body.
 */
export function createFsGlobTool(config: FsGlobConfig) {
  return {
    name: "fs_glob",
    description:
      "Find files by NAME across your mounted reach. Returns paths, sizes and modified dates, newest first — it never reads file contents, so it is cheap and safe to run first. " +
      "USE THIS BEFORE exec/ls/find: it is faster, it is not reviewer-gated, and it already skips node_modules, .git, .venv and other noise. " +
      "Pattern is a shell-style glob matched against the FILE NAME only (not the directory): '*.md', 'CLAW-*.md', 'state.md', '*.tf'. " +
      "Narrow with `subpath` to one directory. Typical flow: fs_glob to locate, then fs_grep to search contents, then read to open the one file you want.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: {
          type: "string",
          description:
            "Shell-style glob matched against the file NAME only. '*' and '?' do not cross directories. Examples: '*.md', 'CLAW-*.md', 'docker-compose.*.yml'.",
        },
        subpath: {
          type: "string",
          description:
            "Optional absolute path to search under, e.g. '/reach/oasis-x/.swarm'. Must be inside your reach; anything outside is rejected. Omit to search every root you have.",
        },
        limit: {
          type: "number",
          description: "Maximum paths to return (default 50, hard cap 100).",
        },
      },
    },
    async execute(
      _toolCallId: string,
      args: { pattern: string; subpath?: string; limit?: number },
    ) {
      const pattern = String(args.pattern ?? "").trim();
      if (!pattern) {
        return json({ error: "pattern is required, e.g. \"*.md\"" });
      }
      if (args.subpath && !resolveInsideRoots(args.subpath, config.search.roots)) {
        return json({
          error: `subpath is outside your reach or does not exist: ${args.subpath}`,
          your_roots: config.search.roots,
        });
      }
      const re = globToRegExp(pattern);
      const limit = Math.max(1, Math.min(Number(args.limit) || 50, config.search.maxResults));
      const { files, scanned, truncated } = walkFiles(config.search, {
        subpath: args.subpath,
        accept: (_abs, basename) => re.test(basename),
      });
      const shown = files.slice(0, limit);
      return json({
        pattern,
        searched: args.subpath ?? config.search.roots,
        files_scanned: scanned,
        matched: files.length,
        returned: shown.length,
        truncated: truncated || files.length > shown.length,
        hint: truncated
          ? "INCOMPLETE: the scan limit was reached, so an absence here does NOT mean the file is absent. Narrow with subpath and search again."
          : undefined,
        files: shown.map((f) => ({
          path: f.path,
          bytes: f.bytes,
          modified: new Date(f.mtimeMs).toISOString().slice(0, 10),
          dir: path.dirname(f.path),
        })),
      });
    },
  };
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
