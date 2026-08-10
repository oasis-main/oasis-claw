import { globToRegExp, grepFiles, resolveInsideRoots, walkFiles, type SearchConfig } from "../search.js";

export interface FsGrepConfig {
  search: SearchConfig;
}

/**
 * fs_grep — find files by CONTENT. The exact-match complement to
 * memory_search: memory_search answers "what do I know about X" fuzzily over an
 * embedded corpus; fs_grep answers "which file contains this exact string"
 * over the live filesystem, including files that are not in any index.
 */
export function createFsGrepTool(config: FsGrepConfig) {
  return {
    name: "fs_grep",
    description:
      "Search file CONTENTS for a regular expression across your mounted reach. Returns path, line number and the matching line, newest files first. " +
      "USE THIS WHEN YOU NEED AN EXACT MATCH — a ticket id, a function name, an error string, a config key. memory_search is fuzzy and only covers indexed files; fs_grep is exact and covers every file you can reach, including code and config. " +
      "USE THIS INSTEAD OF exec grep/rg: no reviewer escalation, and it already skips binaries, node_modules, .git, .venv and secret files. " +
      "Narrow with `include` (name glob) and `subpath` (directory) — an unnarrowed search over a large tree returns less useful results, not more.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: {
          type: "string",
          description:
            "JavaScript regular expression matched per line, e.g. 'CLAW-08[0-9]', 'reach_send\\\\(', 'TODO|FIXME'. Case-insensitive by default.",
        },
        include: {
          type: "string",
          description:
            "Optional file-NAME glob to restrict which files are read, e.g. '*.md', '*.ts', 'queue.md'. Strongly recommended — it is the difference between a useful answer and a wall of noise.",
        },
        subpath: {
          type: "string",
          description:
            "Optional absolute directory to search under, e.g. '/reach/oasis-x/.swarm'. Must be inside your reach. Omit to search every root you have.",
        },
        case_sensitive: {
          type: "boolean",
          description: "Match case exactly (default false).",
        },
        limit: {
          type: "number",
          description: "Maximum matching lines to return (default 40, hard cap 100).",
        },
      },
    },
    async execute(
      _toolCallId: string,
      args: {
        pattern: string;
        include?: string;
        subpath?: string;
        case_sensitive?: boolean;
        limit?: number;
      },
    ) {
      const raw = String(args.pattern ?? "").trim();
      if (!raw) {
        return json({ error: "pattern is required, e.g. \"CLAW-082\"" });
      }
      let re: RegExp;
      try {
        re = new RegExp(raw, args.case_sensitive ? "" : "i");
      } catch (err) {
        return json({ error: `invalid regular expression: ${(err as Error).message}` });
      }
      if (args.subpath && !resolveInsideRoots(args.subpath, config.search.roots)) {
        return json({
          error: `subpath is outside your reach or does not exist: ${args.subpath}`,
          your_roots: config.search.roots,
        });
      }
      const includeRe = args.include ? globToRegExp(args.include) : null;
      const limit = Math.max(1, Math.min(Number(args.limit) || 40, config.search.maxResults));

      const walk = walkFiles(config.search, {
        subpath: args.subpath,
        accept: (_abs, basename) => (includeRe ? includeRe.test(basename) : true),
      });
      const { matches, filesWithMatches, truncated } = grepFiles(
        { ...config.search, maxResults: limit },
        walk.files,
        re,
      );
      return json({
        pattern: raw,
        include: args.include ?? "(all files)",
        searched: args.subpath ?? config.search.roots,
        files_scanned: walk.scanned,
        files_with_matches: filesWithMatches,
        matches_returned: matches.length,
        truncated: truncated || walk.truncated,
        // An honest hint matters more than a tidy one: a truncated scan that
        // says "no match" is a FALSE NEGATIVE, and the agent will believe it.
        hint: (walk.truncated || truncated)
          ? "INCOMPLETE: the scan limit was reached, so these results are NOT exhaustive and an absence here does NOT mean the string is absent. Narrow with subpath and/or include, then search again."
          : matches.length === 0
            ? "No match anywhere in the searched roots. Widen by dropping include, then subpath; or use fs_glob to confirm the files exist."
            : "Open a specific file with the read tool using the path shown.",
        matches,
      });
    },
  };
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
