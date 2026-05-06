/**
 * Walk a configured set of skill roots, find every dir that contains a
 * SKILL.md, and return a deterministic content snapshot per skill (used as
 * both the audit input and the dedupe key against previously-audited skills).
 *
 * We hash the snapshot, not just the SKILL.md, because a malicious update
 * may add a script that wasn't there at first install — we want to re-audit
 * on any content change.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type SkillFile = {
  relPath: string;
  size: number;
  truncated: boolean;
  contents: string;
};

export type SkillSnapshot = {
  skillId: string;
  rootDir: string;
  baseDir: string;
  files: SkillFile[];
  contentHash: string;
};

const AUDITABLE_EXT = new Set([
  ".md",
  ".txt",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".rb",
  ".pl",
  ".ps1",
]);

function isSkillDir(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

function listSkillDirs(rootDir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(rootDir, e.name);
    if (isSkillDir(full)) out.push(full);
  }
  return out;
}

function* walkFiles(baseDir: string): Generator<string> {
  const stack = [baseDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) yield full;
    }
  }
}

export type ScanOpts = {
  maxBytesPerFile: number;
  maxFilesPerSkill: number;
};

export function snapshotSkill(baseDir: string, opts: ScanOpts): SkillSnapshot {
  const files: SkillFile[] = [];
  const skillId = path.basename(baseDir);

  const skillMd = path.join(baseDir, "SKILL.md");
  if (fs.existsSync(skillMd)) {
    files.push(readFileForAudit(skillMd, baseDir, opts.maxBytesPerFile));
  }

  let count = files.length;
  for (const fp of walkFiles(baseDir)) {
    if (count >= opts.maxFilesPerSkill) break;
    if (fp === skillMd) continue;
    const ext = path.extname(fp).toLowerCase();
    if (!AUDITABLE_EXT.has(ext)) continue;
    files.push(readFileForAudit(fp, baseDir, opts.maxBytesPerFile));
    count++;
  }

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const hash = crypto.createHash("sha256");
  for (const f of files) {
    hash.update(f.relPath);
    hash.update("\0");
    hash.update(f.contents);
    hash.update("\0");
  }

  return {
    skillId,
    rootDir: path.dirname(baseDir),
    baseDir,
    files,
    contentHash: hash.digest("hex"),
  };
}

function readFileForAudit(absPath: string, baseDir: string, maxBytes: number): SkillFile {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return { relPath: path.relative(baseDir, absPath), size: 0, truncated: false, contents: "" };
  }
  const fd = fs.openSync(absPath, "r");
  try {
    const len = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return {
      relPath: path.relative(baseDir, absPath),
      size: stat.size,
      truncated: stat.size > maxBytes,
      contents: buf.toString("utf8"),
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function findAllSkills(skillsDirs: readonly string[], opts: ScanOpts): SkillSnapshot[] {
  const seen = new Set<string>();
  const out: SkillSnapshot[] = [];
  for (const root of skillsDirs) {
    const expanded = expandHome(root);
    if (!expanded || !fs.existsSync(expanded)) continue;
    for (const baseDir of listSkillDirs(expanded)) {
      const real = safeRealpath(baseDir);
      if (!real || seen.has(real)) continue;
      seen.add(real);
      out.push(snapshotSkill(baseDir, opts));
    }
  }
  return out;
}

function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return process.env.HOME ?? p;
  if (p.startsWith("~/")) return path.join(process.env.HOME ?? "", p.slice(2));
  if (p.startsWith("$HOME/")) return path.join(process.env.HOME ?? "", p.slice(6));
  return p;
}

function safeRealpath(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}
