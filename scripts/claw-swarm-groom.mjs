#!/usr/bin/env node
// ── claw-swarm-groom: nightly .swarm grooming, stage 1 (no LLM) ─────────────
// Mike, 2026-11-02: at the end of each workday, groom every .swarm board
// against reality. A board whose files, code and PRs did not change in the
// last 7 days is skipped by this script, not by model judgment.
//
// WHAT IT DOES
//   1. Finds every .swarm folder under the root (default ~/Documents/Runes).
//   2. Freshness: the newest of (a) any file in the .swarm folder, (b) the last
//      commit on any branch that touches the board's parent folder, and (c) for
//      a board at a repository root, the last update of any GitHub PR. A local
//      check alone is wrong: on 2026-11-02 the oasis-firmware board looked
//      dormant in a stale clone while its bot updated 3 PRs.
//   3. Mechanical checks on each fresh board only (see checkBoard()).
//   4. Writes GROOM-<date>.md (for Mike and the Monday/Wednesday/Friday
//      report) and GROOM-<date>.json (for the report input script).
//   It changes no board. Stage 2 (Yes Man) proposes edits from this output.
//
// TRUST MODEL
//   Read-only on every repository, except `--fetch`, which updates remote-
//   tracking refs only. Board text is data: it is matched with regexes and
//   never executed. `gh` runs with the Mac's active account; a repository that
//   account cannot see gives "github: not visible", not an error.
//
// Usage: node scripts/claw-swarm-groom.mjs [--root DIR] [--out DIR] [--days N]
//          [--fetch] [--no-github] [--print]
//   Env: OASIS_GROOM_SKIP  extra folder names to skip, comma list

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const DAY_MS = 24 * 3600 * 1000;
// Never walk into these. oasis-fairskies-wds: Mike, never touch Fairskies.
export const SKIP_NAMES = new Set(["node_modules", "vendor", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".claude", ".next", "oasis-fairskies-wds"]);
const MAX_DEPTH = 8;
/** An in-progress or claimed item with no dated note for this long is flagged. */
export const STALE_CLAIM_DAYS = 14;
/** state.md this much older than queue.md is flagged. */
export const STATE_BEHIND_DAYS = 14;
const MAX_GH_CALLS = 300;
const MAX_FINDINGS_PER_CHECK = 25;

// ── discovery ──

export function findBoards(root, skip = SKIP_NAMES) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.name === ".swarm") {
        out.push(p);
        continue;
      }
      if (skip.has(e.name) || e.name.endsWith("-worktrees") || depth >= MAX_DEPTH) continue;
      walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out.sort();
}

/** Newest mtime (ms) of any file in a folder tree, 4 levels deep. */
export function newestMtime(dir, depth = 0) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (depth < 4) newest = Math.max(newest, newestMtime(p, depth + 1));
    } else {
      try {
        newest = Math.max(newest, lstatSync(p).mtimeMs);
      } catch {
        // gone between readdir and stat
      }
    }
  }
  return newest;
}

/** Fresh when any source changed within `days`. Missing sources count as never. */
export function isFresh({ swarmMtime = 0, lastCommit = 0, lastPr = 0 }, now, days) {
  const newest = Math.max(swarmMtime || 0, lastCommit || 0, lastPr || 0);
  return { fresh: newest >= now - days * DAY_MS, newest };
}

// ── git and gh ──

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: opts.timeout ?? 30_000, cwd: opts.cwd }).trim();
  } catch {
    return null;
  }
}

export function makeGit(runner = run) {
  return {
    top: (dir) => runner("git", ["-C", dir, "rev-parse", "--show-toplevel"]),
    fetch: (top) => runner("git", ["-C", top, "fetch", "--all", "--quiet"], { timeout: 90_000 }),
    /** Last commit time (ms) on any branch that touches `path` (relative to top; "" = whole repo). */
    lastCommit: (top, path) => {
      const out = runner("git", ["-C", top, "log", "--all", "-1", "--format=%ct", ...(path ? ["--", path] : [])]);
      return out ? Number(out) * 1000 : 0;
    },
    fileCommit: (top, file) => {
      const out = runner("git", ["-C", top, "log", "-1", "--format=%ct", "--", file]);
      return out ? Number(out) * 1000 : 0;
    },
    dirty: (top, path) => {
      const out = runner("git", ["-C", top, "status", "--porcelain", "--", path]);
      return out ? out.split("\n").filter(Boolean).length : 0;
    },
    /** The first GitHub remote (bot clones do not always name it origin). */
    remote: (top) => {
      const out = runner("git", ["-C", top, "remote", "-v"]);
      return (out ?? "").split("\n").map((l) => l.split(/\s+/)[1]).find((u) => githubSlug(u)) ?? null;
    },
  };
}

export function githubSlug(url) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url ?? ""));
  return m ? `${m[1]}/${m[2]}` : null;
}

export function makeGh(runner = run) {
  const cache = new Map();
  let calls = 0;
  const api = (path, jq) => {
    if (cache.has(path)) return cache.get(path);
    if (calls >= MAX_GH_CALLS) return undefined;
    calls++;
    const out = runner("gh", ["api", path, "--jq", jq], { timeout: 20_000 });
    const v = out === null ? null : out;
    cache.set(path, v);
    return v;
  };
  return {
    /** ms of the newest PR update, 0 when none, null when the repo is not visible. */
    lastPr: (slug) => {
      const v = api(`repos/${slug}/pulls?state=all&sort=updated&direction=desc&per_page=1`, ".[0].updated_at // \"\"");
      if (v === null || v === undefined) return null;
      return v ? Date.parse(v) : 0;
    },
    /** "merged" | "closed" | "open" | null */
    prState: (slug, n) => {
      const v = api(`repos/${slug}/pulls/${n}`, 'if .merged_at then "merged" else .state end');
      return v || null;
    },
    get calls() {
      return calls;
    },
  };
}

// ── board parsing ──

const ITEM_RE = /^\s*[-*]\s*\[(.)\]\s*\[([A-Z][A-Z0-9]*-\d+)\]\s*(?:\[([^\]]*)\])?\s*(.*)$/;

/** Items of a queue.md: marker, id, tag, title, 1-based line, and the block text up to the next item or heading. */
export function parseItems(text) {
  const lines = String(text ?? "").split("\n");
  const items = [];
  let cur = null;
  lines.forEach((line, i) => {
    const m = ITEM_RE.exec(line);
    if (m) {
      cur = { marker: m[1], id: m[2], tag: m[3] ?? "", title: m[4].trim(), line: i + 1, block: line };
      items.push(cur);
    } else if (/^#{1,6}\s/.test(line)) {
      cur = null;
    } else if (cur) {
      cur.block += `\n${line}`;
    }
  });
  return items;
}

const DATE_RE = /\b(20\d\d)-(\d\d)-(\d\d)\b/g;

export function newestDate(text) {
  let best = 0;
  for (const m of String(text).matchAll(DATE_RE)) {
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (Number.isFinite(t)) best = Math.max(best, t);
  }
  return best;
}

// A word before "PR #N" that names a repository: hyphenated (oasis-cloud) or
// one of these. "openclaw PR #117372" is not a PR of the board's own repo.
const REPO_WORDS = new Set(["openclaw", "upstream", "exp", "dot_swarm"]);

/**
 * PR references: full URLs, owner/repo#N, "<repo> PR #N" (same owner as the
 * board), and a bare "PR #N" (the board's own repo). A guess that names the
 * wrong owner finds no PR, so it gives no finding.
 */
export function prRefs(text, ownSlug) {
  const refs = new Map();
  const put = (slug, n) => refs.set(`${slug}#${n}`, { slug, n: Number(n) });
  for (const m of String(text).matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) put(m[1], m[2]);
  for (const m of String(text).matchAll(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/g)) put(m[1], m[2]);
  if (!ownSlug) return [...refs.values()];
  const [owner, own] = ownSlug.split("/");
  for (const m of String(text).matchAll(/(?:\b([\w.-]+)\s+)?PRs?\s+#(\d+)\b/g)) {
    const word = m[1] ?? "";
    const repoWord = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i.test(word) || REPO_WORDS.has(word.toLowerCase());
    put(repoWord && word !== own ? `${owner}/${word}` : ownSlug, m[2]);
  }
  return [...refs.values()];
}

/** Backticked relative paths that look like files or folders. */
export function pathRefs(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/`([^`\s]+)`/g)) {
    const p = m[1].replace(/:\d+(?:-\d+)?$/, "");
    if (!p.includes("/") || /^[a-z]+:\/\//i.test(p) || p.startsWith("/") || p.startsWith("~") || /[*<>{}$|]/.test(p)) continue;
    if (!/\.[A-Za-z0-9]{1,6}$/.test(p) && !p.endsWith("/")) continue;
    out.add(p);
  }
  return [...out];
}

// ── checks ──

const OPEN_MARKERS = new Set([" ", "~", "/", ">", "!"]);
const CLAIM_MARKERS = new Set(["~", "/", ">"]);

/**
 * Mechanical checks on one fresh board. Every finding names the file, the
 * line, what the board says and what the check found. No finding changes a
 * board. Returns [{check, file, line, id, says, found}].
 */
export function checkBoard(board, { git, gh, now }) {
  const findings = [];
  const add = (f) => {
    if (findings.filter((x) => x.check === f.check).length < MAX_FINDINGS_PER_CHECK) findings.push(f);
  };
  const queuePath = join(board.swarm, "queue.md");
  const queue = existsSync(queuePath) ? readFileSync(queuePath, "utf8") : "";
  const items = parseItems(queue);
  const qrel = relative(board.root, queuePath);

  // 1. One ID names two items.
  const seen = new Map();
  for (const it of items) {
    if (seen.has(it.id)) add({ check: "duplicate-id", file: qrel, line: it.line, id: it.id, says: `also at line ${seen.get(it.id)}`, found: "two items use this ID" });
    else seen.set(it.id, it.line);
  }

  for (const it of items) {
    if (!OPEN_MARKERS.has(it.marker)) continue;
    // 2. Every PR the item names is merged or closed, but the item is open.
    const refs = prRefs(it.block, board.slug);
    if (refs.length && gh) {
      const states = refs.map((r) => ({ ...r, state: gh.prState(r.slug, r.n) }));
      if (states.every((s) => s.state === "merged" || s.state === "closed")) {
        add({ check: "merged-but-open", file: qrel, line: it.line, id: it.id, says: `[${it.marker}] ${it.tag}`.trim(), found: `${states.map((s) => `${s.slug}#${s.n} ${s.state}`).join(", ")}` });
      }
    }
    // 3. Claimed or in progress, with no dated note for STALE_CLAIM_DAYS.
    if (CLAIM_MARKERS.has(it.marker)) {
      const last = newestDate(it.block);
      if (last && now - last > STALE_CLAIM_DAYS * DAY_MS) {
        add({ check: "stale-claim", file: qrel, line: it.line, id: it.id, says: `[${it.marker}] ${it.tag}`.trim(), found: `newest date in the item is ${new Date(last).toISOString().slice(0, 10)} (${Math.floor((now - last) / DAY_MS)} days)` });
      }
    }
    // 4. A path the item names does not exist. Only paths whose first folder
    // exists here count: a path in another repository is not a finding.
    const bases = [board.swarm, board.parent, board.top, board.root].filter(Boolean);
    for (const p of pathRefs(it.block)) {
      const first = p.split("/")[0];
      if (!bases.some((b) => existsSync(join(b, first)))) continue;
      if (!bases.some((b) => existsSync(join(b, p)))) add({ check: "missing-path", file: qrel, line: it.line, id: it.id, says: `\`${p}\``, found: "no such file or folder" });
    }
  }

  // 5. state.md far behind queue.md.
  const statePath = join(board.swarm, "state.md");
  if (existsSync(statePath) && existsSync(queuePath)) {
    const when = (f) => (board.top && git ? git.fileCommit(board.top, f) : 0) || statSync(f).mtimeMs;
    const s = when(statePath);
    const q = when(queuePath);
    if (q - s > STATE_BEHIND_DAYS * DAY_MS) {
      add({ check: "state-behind", file: relative(board.root, statePath), line: 1, id: null, says: `last change ${new Date(s).toISOString().slice(0, 10)}`, found: `queue.md changed ${new Date(q).toISOString().slice(0, 10)}, ${Math.floor((q - s) / DAY_MS)} days later` });
    }
  }

  // 6. Uncommitted board changes.
  if (board.top && git) {
    const n = git.dirty(board.top, relative(board.top, board.swarm) || ".");
    if (n) add({ check: "uncommitted", file: relative(board.root, board.swarm), line: null, id: null, says: "", found: `${n} changed or untracked paths` });
  }
  return findings;
}

// ── run ──

export function groom({ root, days = 7, fetch = false, github = true, now = Date.now(), git = makeGit(), gh = makeGh() }) {
  const boards = [];
  const fetched = new Set();
  for (const swarm of findBoards(root)) {
    const parent = dirname(swarm);
    const top = git.top(parent);
    if (top && fetch && !fetched.has(top)) {
      git.fetch(top);
      fetched.add(top);
    }
    const relInRepo = top ? relative(top, parent) : "";
    const slug = top ? githubSlug(git.remote(top)) : null;
    const atRoot = Boolean(top) && relInRepo === "";
    const swarmMtime = newestMtime(swarm);
    const lastCommit = top ? git.lastCommit(top, relInRepo) : 0;
    const lastPr = atRoot && slug && github ? gh.lastPr(slug) : null;
    const { fresh, newest } = isFresh({ swarmMtime, lastCommit, lastPr: lastPr ?? 0 }, now, days);
    boards.push({
      swarm,
      parent,
      root,
      top,
      slug,
      name: relative(root, parent) || basename(root),
      swarm_mtime: swarmMtime,
      last_commit: lastCommit,
      last_pr: lastPr,
      github: !atRoot || !slug || !github ? "n/a" : lastPr === null ? "not visible" : "ok",
      newest,
      fresh,
    });
  }
  for (const b of boards) b.findings = b.fresh ? checkBoard(b, { git, gh: github ? gh : null, now }) : [];
  return { generated_at: new Date(now).toISOString(), root, days, boards, gh_calls: gh.calls ?? 0 };
}

const CHECK_TEXT = {
  "merged-but-open": "Every PR that the item names is merged or closed, but the item is open",
  "stale-claim": `The item is claimed or in progress, but its newest date is more than ${STALE_CLAIM_DAYS} days old`,
  "missing-path": "A path that the item names does not exist",
  "duplicate-id": "Two items use the same ID",
  "state-behind": `state.md is more than ${STATE_BEHIND_DAYS} days older than queue.md`,
  uncommitted: "The board has changes that are not committed",
};

const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "never");
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function toMarkdown(r) {
  const fresh = r.boards.filter((b) => b.fresh);
  const dormant = r.boards.filter((b) => !b.fresh);
  const total = fresh.reduce((n, b) => n + b.findings.length, 0);
  const L = [
    "---",
    "type: swarm-grooming",
    `date: ${r.generated_at.slice(0, 10)}`,
    "mode: read-only (no board changed)",
    "stage: 1 (script, no LLM)",
    "---",
    "",
    `# .swarm grooming: ${r.generated_at.slice(0, 10)}`,
    "",
    `The script found ${r.boards.length} boards under \`${r.root}\`.`,
    `- ${fresh.length} boards changed in the last ${r.days} days. The script checked these boards and found ${total} items to look at.`,
    `- ${dormant.length} boards did not change in the last ${r.days} days. The script skipped them.`,
    "- A board counts as changed when its .swarm files, a commit on any branch in its folder, or (for a repository root) a GitHub PR changed.",
    "",
    "## Checked boards",
    "",
  ];
  for (const b of fresh) {
    L.push(`### ${b.name}`, "", `Newest change ${day(b.newest)}. .swarm files ${day(b.swarm_mtime)}, last commit ${day(b.last_commit)}, GitHub ${b.github === "ok" ? day(b.last_pr) : b.github}.`, "");
    if (!b.findings.length) {
      L.push("No findings.", "");
      continue;
    }
    L.push("| Check | Item | File:line | Board says | Found |", "|---|---|---|---|---|");
    for (const f of b.findings) L.push(`| ${CHECK_TEXT[f.check] ?? f.check} | ${f.id ?? "-"} | ${cell(f.file)}${f.line ? `:${f.line}` : ""} | ${cell(f.says)} | ${cell(f.found)} |`);
    L.push("");
  }
  L.push("## Skipped boards (no change in the window)", "", "| Board | Newest change |", "|---|---|");
  for (const b of dormant) L.push(`| ${cell(b.name)} | ${day(b.newest)} |`);
  L.push("");
  return L.join("\n");
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

function nyDate(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

function main(argv) {
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const root = arg("--root", join(homedir(), "Documents", "Runes"));
  const out = arg("--out", join(homedir(), "Documents", "Runes", "oasis-x", ".swarm", "fleet"));
  const days = Number(arg("--days", "7"));
  for (const extra of String(process.env.OASIS_GROOM_SKIP ?? "").split(",").map((s) => s.trim()).filter(Boolean)) SKIP_NAMES.add(extra);
  const r = groom({ root, days, fetch: argv.includes("--fetch"), github: !argv.includes("--no-github") });
  const md = toMarkdown(r);
  if (argv.includes("--print")) {
    process.stdout.write(md);
    return;
  }
  const date = nyDate(Date.now());
  writeAtomic(join(out, `GROOM-${date}.md`), md);
  writeAtomic(join(out, `GROOM-${date}.json`), JSON.stringify(r, null, 2));
  const fresh = r.boards.filter((b) => b.fresh);
  process.stdout.write(`[claw-swarm-groom] ${r.boards.length} boards, ${fresh.length} checked, ${fresh.reduce((n, b) => n + b.findings.length, 0)} findings, ${r.gh_calls} gh calls -> ${join(out, `GROOM-${date}.md`)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
