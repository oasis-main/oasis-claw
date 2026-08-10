import fs from "node:fs";
import path from "node:path";

/**
 * Filesystem search core for oasis-find (CLAW-082 phase 3).
 *
 * WHY THIS ENFORCES ITS OWN SAFETY RULES. The oasis-reviewer governs file
 * READS through Layer-1 path rules that key off `event.derivedPaths`, and core
 * only populates that for its own file tools. A plugin tool arrives at the
 * before_tool_call hook with a name and params and no derived paths, so the
 * reviewer's denyReadGlobs never fires for it — the same blind spot that kept
 * dot-swarm's `compact` out of the allowlist. A search tool is the worst place
 * to inherit that blind spot: walking a tree and grepping it is exactly how a
 * secret leaks. So every rule the reviewer would have applied is applied here,
 * and the deny list is kept identical to reviewer-policy.json hard.fleet.
 */

export type SearchConfig = {
  /** Absolute roots the bot may search. Everything outside is unreachable. */
  roots: string[];
  /** Basename globs that are never listed and never read. */
  denyGlobs: string[];
  /** Directory names skipped during the walk. */
  denyDirs: string[];
  maxResults: number;
  maxFileBytes: number;
  maxMatchesPerFile: number;
  maxScannedFiles: number;
};

/** Mirrors reviewer-policy.json hard.fleet.denyReadGlobs, plus dotfile creds. */
export const DEFAULT_DENY_GLOBS = [
  "*.pem",
  "id_*",
  "*.key",
  "*_rsa",
  "*_ed25519",
  ".env*",
  "*.env",
  "credentials",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "auth-profiles.json",
  ".gateway-token",
];

/**
 * Directories skipped outright. `pliny` is NOT hygiene — reviewer-policy.json
 * marks /pliny "OFF-LIMITS sensitive project content" for Van Helsing and
 * forbids reading around in it; a content grep is precisely "reading around".
 * The rest are noise that would drown a result set: the oasis-hardware tree
 * alone holds 21,836 markdown files under "External Reference Repos".
 */
export const DEFAULT_DENY_DIRS = [
  "pliny",
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  ".next",
  ".cache",
  "External Reference Repos",
  ".claw-mail",
  "secrets",
];

export const DEFAULT_SEARCH_LIMITS = {
  maxResults: 100,
  maxFileBytes: 2_000_000,
  maxMatchesPerFile: 5,
  maxScannedFiles: 20_000,
};

/** Translate a shell-style glob to an anchored RegExp. `**` is not special here. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

export function isDenied(basename: string, denyGlobs: string[]): boolean {
  return denyGlobs.some((g) => globToRegExp(g).test(basename));
}

/**
 * Resolve `candidate` and confirm it stays inside one of `roots`.
 *
 * realpath() is the load-bearing call: it collapses `..` AND follows symlinks,
 * so a symlink planted inside a reach mount cannot point the search at /etc or
 * at another bot's tree. Returns null when the path escapes or does not exist.
 */
export function resolveInsideRoots(candidate: string, roots: string[]): string | null {
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      continue;
    }
    if (real === realRoot || real.startsWith(`${realRoot}${path.sep}`)) {
      return real;
    }
  }
  return null;
}

export type WalkHit = { path: string; bytes: number; mtimeMs: number };

/** Walk the allowed roots, applying deny rules. Bounded by maxScannedFiles. */
export function walkFiles(
  config: SearchConfig,
  opts: { subpath?: string; accept: (absPath: string, basename: string) => boolean },
): { files: WalkHit[]; scanned: number; truncated: boolean } {
  const files: WalkHit[] = [];
  let scanned = 0;
  let truncated = false;

  const startRoots = opts.subpath
    ? [resolveInsideRoots(opts.subpath, config.roots)].filter((p): p is string => !!p)
    : config.roots.map((r) => resolveInsideRoots(r, config.roots)).filter((p): p is string => !!p);

  // Per-root scan budget, NOT one shared pool consumed in order.
  //
  // With a shared pool the first root eats it and later roots are never
  // reached — House searched /reach for "CLAW-079", /reach/oasis-x (35,373
  // markdown files alone) consumed all 20,000 scans, /reach/claw-swarm was
  // never opened, and the tool returned "no matches" for a string that was
  // sitting in claw-swarm/queue.md. A false negative is worse than a slow
  // answer. Same starvation shape as the dot-swarm byte budget (CLAW-082).
  // Unused budget rolls forward, so a small root does not waste its share.
  const seen = new Set<string>();
  let carry = 0;
  for (let rootIndex = 0; rootIndex < startRoots.length; rootIndex += 1) {
    const root = startRoots[rootIndex];
    const remainingRoots = startRoots.length - rootIndex;
    const share =
      Math.floor((config.maxScannedFiles - scanned) / remainingRoots) + carry;
    const rootBudgetEnd = scanned + Math.max(1, share);
    const stack = [root];
    while (stack.length > 0) {
      if (scanned >= rootBudgetEnd || scanned >= config.maxScannedFiles) {
        truncated = true;
        break;
      }
      const dir = stack.pop() as string;
      if (seen.has(dir)) continue;
      seen.add(dir);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (config.denyDirs.includes(entry.name)) continue;
          stack.push(abs);
          continue;
        }
        // Symlinked FILES are skipped rather than resolved: a symlink is the
        // cheap way to smuggle an out-of-root file into an in-root listing.
        if (!entry.isFile()) continue;
        if (isDenied(entry.name, config.denyGlobs)) continue;
        scanned += 1;
        if (scanned >= rootBudgetEnd || scanned >= config.maxScannedFiles) {
          truncated = true;
          break;
        }
        if (!opts.accept(abs, entry.name)) continue;
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        files.push({ path: abs, bytes: st.size, mtimeMs: st.mtimeMs });
      }
    }
    // Whatever this root did not spend goes to the roots after it.
    carry = Math.max(0, rootBudgetEnd - scanned);
  }
  // Newest first — the same ordering Claude Code's Glob uses, because "what
  // changed recently" is the usual intent behind a filename search.
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { files, scanned, truncated };
}

/** Cheap binary sniff: a NUL in the first 8 KB means "do not grep this". */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export type GrepMatch = { path: string; line: number; text: string };

export function grepFiles(
  config: SearchConfig,
  files: WalkHit[],
  pattern: RegExp,
): { matches: GrepMatch[]; filesWithMatches: number; truncated: boolean } {
  const matches: GrepMatch[] = [];
  let filesWithMatches = 0;
  let truncated = false;

  for (const file of files) {
    if (matches.length >= config.maxResults) {
      truncated = true;
      break;
    }
    if (file.bytes > config.maxFileBytes) continue;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file.path);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const lines = buf.toString("utf8").split("\n");
    let perFile = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (perFile >= config.maxMatchesPerFile) break;
      if (matches.length >= config.maxResults) {
        truncated = true;
        break;
      }
      // Reset lastIndex so a caller-supplied /g regex cannot skip lines.
      pattern.lastIndex = 0;
      if (!pattern.test(lines[i])) continue;
      perFile += 1;
      matches.push({ path: file.path, line: i + 1, text: lines[i].slice(0, 400) });
    }
    if (perFile > 0) filesWithMatches += 1;
  }
  return { matches, filesWithMatches, truncated };
}
