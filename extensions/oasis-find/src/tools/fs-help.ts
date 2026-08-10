export interface FsHelpConfig {
  roots: string[];
}

/**
 * fs_help — how to use fs_glob and fs_grep, and when to prefer each of the four
 * search surfaces this fleet has.
 *
 * WHY A TOOL AND NOT A MEMORY SUPPLEMENT. registerMemoryPromptSupplement is a
 * silent no-op on these bots (CLAW-083) — dot-swarm's supplement never reached
 * a single system prompt. Guidance therefore has to travel where the model
 * actually looks: tool DESCRIPTIONS, which are part of the schema, plus this
 * pull-on-demand page.
 *
 * NO BACKTICKS ANYWHERE IN THE TEMPLATE LITERAL BELOW. One stray backtick in
 * oasis-reach's help tool was a syntax error that stopped the whole plugin from
 * loading, and every test passed because none of them imported the file.
 */
export function createFsHelpTool(config: FsHelpConfig) {
  return {
    name: "fs_help",
    description:
      "How to search your filesystem well: when to use fs_glob vs fs_grep vs memory_search vs swarm_read, worked examples, and what is deliberately unreachable. Read this once if you are unsure which search tool to reach for.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute() {
      const roots = config.roots.length ? config.roots.join("\n  ") : "(none configured)";
      const text = [
        "# Searching your workspace",
        "",
        "You have FOUR search surfaces. They answer different questions. Picking the",
        "wrong one is the main reason a search comes back useless.",
        "",
        "## 1. fs_glob - WHERE does a file live?",
        "Matches a shell-style glob against the FILE NAME. Never reads contents, so it",
        "is the cheapest thing you can run. Results are newest-modified first.",
        "",
        "  fs_glob {\"pattern\": \"*.md\", \"subpath\": \"/reach/oasis-x/.swarm\"}",
        "  fs_glob {\"pattern\": \"docker-compose.*.yml\"}",
        "",
        "## 2. fs_grep - WHICH file contains this exact text?",
        "Regular expression matched per line over file contents. Exact, live, and it",
        "covers files that no index knows about.",
        "",
        "  fs_grep {\"pattern\": \"CLAW-08[0-9]\", \"include\": \"*.md\"}",
        "  fs_grep {\"pattern\": \"OASIS_REACH_ENABLE\", \"include\": \"*.yml\"}",
        "",
        "ALWAYS pass include when you can. An unnarrowed grep over a large tree gives",
        "you less signal, not more.",
        "",
        "## 3. memory_search - WHAT do I know about this topic?",
        "Fuzzy semantic search over an INDEX: your memory files, your past session",
        "transcripts, and the .swarm project boards in your reach. Use it for recall",
        "and for questions phrased as ideas rather than strings. It will not find a",
        "file that is not indexed, and it will not match an exact identifier reliably.",
        "",
        "## 4. swarm_read - what is the CURRENT state of my project board?",
        "Reads state.md and queue.md from your own .swarm board, live. Use it when you",
        "need the authoritative current plan rather than a recollection of it.",
        "",
        "## Choosing, in one line each",
        "  I know part of the filename          -> fs_glob",
        "  I know an exact string in the file   -> fs_grep",
        "  I remember a topic, not a string     -> memory_search",
        "  I need the live project plan         -> swarm_read",
        "  I have the exact path already        -> read",
        "",
        "## The usual sequence",
        "Locate, then narrow, then open. fs_glob or fs_grep to find the path, then the",
        "read tool on the one file you actually want. Do not read ten files to find",
        "one; grep for the string that only the right file contains.",
        "",
        "## Prefer these over exec",
        "Running ls, find, grep or rg through exec goes to the reviewer and may be",
        "escalated or denied, and it costs seconds. fs_glob and fs_grep are not",
        "reviewer-gated because they are read-only, root-confined, and refuse secrets",
        "by construction. Use them.",
        "",
        "## Your search roots",
        "  " + roots,
        "",
        "Anything outside those roots is unreachable, including through a symlink or a",
        "path containing dot-dot. That is enforced, not advisory.",
        "",
        "## What is deliberately excluded",
        "Secret-shaped files are never listed or read: .env files, private keys,",
        "id_* files, credentials, auth profiles, gateway tokens.",
        "Noise directories are skipped: .git, node_modules, .venv, dist, build,",
        "__pycache__, and vendored reference trees.",
        "The pliny directory is off-limits sensitive content from a separate project.",
        "Do not attempt to reach it by another route.",
        "",
        "If a search returns nothing, widen in this order: drop include, then drop",
        "subpath, then shorten the pattern. If it returns too much, do the reverse.",
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  };
}
