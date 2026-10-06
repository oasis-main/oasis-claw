/**
 * Memory tidy — keep MEMORY.md under the bootstrap budget by MOVING whole
 * sections, verbatim, into memory/archive/ (Mike, 2026-10-06: "verbatim only,
 * whole fleet").
 *
 * Why: openclaw injects MEMORY.md into every prompt and truncates it past the
 * bootstrap limit (20,000 chars: "workspace bootstrap file MEMORY.md is 22712
 * chars (limit 20000); truncating"). memory-core dreaming only ever APPENDS to
 * MEMORY.md and the bot appends too, so nothing ever shrinks it. Everything
 * under memory/ is indexed recursively by memory_search, so an archived section
 * stays searchable and citable by path; MEMORY.md keeps a one-line pointer.
 *
 * Selection never relies on recall counts: MEMORY.md is always in the prompt,
 * so the bot rarely memory_searches it and its sections show ~zero recalls
 * whether they matter or not. Instead, in order:
 *   1. sections whose heading says HISTORICAL / SUPERSEDED / OBSOLETE / ARCHIVED
 *   2. dreaming "Promoted From Short-Term Memory (<date>)" blocks older than
 *      promotedMaxAgeDays
 *   3. sections with a date in the heading older than datedMaxAgeDays,
 *      oldest first
 * until the file is at or under targetChars. Undated, unmarked sections are
 * never moved automatically; if the file is still over budget the result says
 * so (overBudget) and the waking summary asks the bot to curate it.
 *
 * Protected (never moved): the preamble before the first "## ", sections marked
 * `<!-- pin -->`, headings naming identity / Mike / CURRENT / SUPERSEDES, any
 * standing instruction (rule, protocol, discipline, guideline, policy, or a
 * "(Mike, <date>)" attribution), and the archive index.
 *
 * Pure planning (planTidy) is separated from IO (applyTidy) so it can be tested
 * without a filesystem. No LLM, no embeddings: text moves byte-for-byte.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ARCHIVE_INDEX_HEADING = "## Archive index (sleep-cycle memory tidy)";
const ARCHIVE_INDEX_NOTE =
  "Sections moved verbatim out of this file to keep it under the prompt budget. " +
  "memory_search finds their full text; memory_get or read opens the file.";

export type TidyConfig = {
  enabled: boolean;
  /** Start tidying when MEMORY.md is larger than this many chars. */
  softCapChars: number;
  /** Stop once MEMORY.md is at or under this many chars. */
  targetChars: number;
  promotedMaxAgeDays: number;
  datedMaxAgeDays: number;
  /** Move dream phase reports older than this out of the search index (0 = off). */
  dreamReportRetentionDays: number;
  /** Move daily notes memory/YYYY-MM-DD.md older than this into memory/archive/daily (0 = off). */
  dailyNoteRetentionDays: number;
  /** Minimum hours between tidy runs. */
  minHoursBetweenRuns: number;
};

export const TIDY_DEFAULTS: TidyConfig = {
  enabled: true,
  softCapChars: 16_000,
  targetChars: 14_000,
  promotedMaxAgeDays: 14,
  datedMaxAgeDays: 30,
  dreamReportRetentionDays: 14,
  dailyNoteRetentionDays: 30,
  minHoursBetweenRuns: 20,
};

export type Section = {
  heading: string;
  /** Full text of the section including its heading line and ### children. */
  text: string;
  /** Newest date found in the heading (ms since epoch, UTC midnight), if any. */
  datedMs?: number;
  kind: "preamble" | "index" | "section";
  historical: boolean;
  promoted: boolean;
  pinned: boolean;
};

export type TidyMove = {
  heading: string;
  reason: "historical" | "promoted-stale" | "dated-stale";
  chars: number;
  datedMs?: number;
};

export type TidyPlan = {
  beforeChars: number;
  afterChars: number;
  moves: TidyMove[];
  overBudget: boolean;
  /** The sections to move, in file order, aligned with moves by heading. */
  moveSections: Section[];
};

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

const HISTORICAL_RE = /\b(HISTORICAL|SUPERSEDED|OBSOLETE|ARCHIVED|DEPRECATED)\b/;
const PROMOTED_RE = /^##\s+Promoted From Short-Term Memory\b/i;
// Standing instructions do not go stale with age: "Options Exit Discipline
// (Mike, 2026-09-23)" or "Peer Request Paging Protocol (Mike's Rule, added
// 2026-09-08)" carry a date but stay in force until Mike changes them.
const PROTECTED_RE =
  /\b(identity|about mike|notes on mike|current|supersedes|rules?|protocols?|discipline|guidelines?|polic(?:y|ies))\b|\(Mike\b/i;
const PIN_RE = /<!--\s*pin\s*-->/i;

/** Newest date mentioned in a heading, as UTC-midnight ms. Pure. */
export function headingDateMs(heading: string): number | undefined {
  const found: number[] = [];
  for (const m of heading.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
    found.push(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }
  for (const m of heading.matchAll(/\b(20\d{2})(\d{2})(\d{2})\b/g)) {
    const mo = +m[2];
    const d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) found.push(Date.UTC(+m[1], mo - 1, d));
  }
  // "Aug 10 2026", "Aug 8, 2026", "September 23, 2026"
  for (const m of heading.matchAll(/\b([A-Z][a-z]{2,8})\.?\s+(\d{1,2}),?\s+(20\d{2})\b/g)) {
    const mo = MONTHS[m[1].slice(0, m[1].toLowerCase().startsWith("sept") ? 4 : 3).toLowerCase()];
    if (mo !== undefined) found.push(Date.UTC(+m[3], mo, +m[2]));
  }
  return found.length ? Math.max(...found) : undefined;
}

/**
 * Split MEMORY.md into level-2 sections. "### " children stay with their
 * parent "## ". Text before the first "## " is the preamble. Lines inside
 * fenced code blocks never start a section. Pure; concatenating every
 * section's text reproduces the input exactly.
 */
export function splitSections(md: string): Section[] {
  const lines = md.split(/(?<=\n)/);
  const sections: Section[] = [];
  let cur: { heading: string; lines: string[] } = { heading: "", lines: [] };
  let inFence = false;
  const push = () => {
    const text = cur.lines.join("");
    if (!text && !cur.heading) return;
    sections.push(describe(cur.heading, text, sections.length === 0 && !cur.heading));
  };
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^##\s/.test(line)) {
      push();
      cur = { heading: line.trim(), lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  push();
  return sections;
}

function describe(heading: string, text: string, isPreamble: boolean): Section {
  if (isPreamble) {
    return { heading: "", text, kind: "preamble", historical: false, promoted: false, pinned: true };
  }
  const isIndex = heading.startsWith(ARCHIVE_INDEX_HEADING.slice(0, 16)) && heading.includes("Archive index");
  return {
    heading,
    text,
    datedMs: headingDateMs(heading),
    kind: isIndex ? "index" : "section",
    historical: HISTORICAL_RE.test(heading),
    promoted: PROMOTED_RE.test(heading),
    pinned: isIndex || PIN_RE.test(text) || PROTECTED_RE.test(heading),
  };
}

/** Decide which sections to move. Pure. */
export function planTidy(md: string, cfg: TidyConfig, nowMs: number): TidyPlan {
  const sections = splitSections(md);
  const beforeChars = md.length;
  const empty: TidyPlan = { beforeChars, afterChars: beforeChars, moves: [], overBudget: false, moveSections: [] };
  if (beforeChars <= cfg.softCapChars) return empty;

  const day = 86_400_000;
  const movable = sections.filter((s) => s.kind === "section" && !s.pinned);
  const byAge = (a: Section, b: Section) => (a.datedMs ?? 0) - (b.datedMs ?? 0);
  const tiers: Array<{ reason: TidyMove["reason"]; list: Section[] }> = [
    { reason: "historical", list: movable.filter((s) => s.historical).sort(byAge) },
    {
      reason: "promoted-stale",
      list: movable
        .filter((s) => !s.historical && s.promoted && s.datedMs !== undefined && nowMs - s.datedMs > cfg.promotedMaxAgeDays * day)
        .sort(byAge),
    },
    {
      reason: "dated-stale",
      list: movable
        .filter((s) => !s.historical && !s.promoted && s.datedMs !== undefined && nowMs - s.datedMs > cfg.datedMaxAgeDays * day)
        .sort(byAge),
    },
  ];

  // Each move removes the section and adds one index line (~heading + path).
  const indexLineCost = (s: Section) => s.heading.length + 80;
  const hasIndex = sections.some((s) => s.kind === "index");
  let size = beforeChars + (hasIndex ? 0 : ARCHIVE_INDEX_HEADING.length + ARCHIVE_INDEX_NOTE.length + 4);
  const chosen = new Map<Section, TidyMove["reason"]>();
  for (const tier of tiers) {
    for (const s of tier.list) {
      if (size <= cfg.targetChars) break;
      if (chosen.has(s)) continue;
      chosen.set(s, tier.reason);
      size += indexLineCost(s) - s.text.length;
    }
  }
  if (chosen.size === 0) return { ...empty, overBudget: true };
  const moveSections = sections.filter((s) => chosen.has(s));
  return {
    beforeChars,
    afterChars: size,
    moves: moveSections.map((s) => ({ heading: s.heading, reason: chosen.get(s)!, chars: s.text.length, datedMs: s.datedMs })),
    // "Over budget" = still above the soft cap, i.e. the bot must curate.
    // Landing a little above targetChars is fine; the next run continues.
    overBudget: size > cfg.softCapChars,
    moveSections,
  };
}

export function slugify(heading: string): string {
  return (
    heading
      .replace(/^#+\s*/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "section"
  );
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Rebuild MEMORY.md without the moved sections and with index lines appended
 * to the archive index (created at the end of the file if absent). Pure.
 */
export function rewriteMemory(md: string, moved: Array<{ section: Section; relPath: string; reason: string }>, nowMs: number): string {
  const sections = splitSections(md);
  const movedSet = new Set(moved.map((m) => m.section.text));
  const kept = sections.filter((s) => !movedSet.has(s.text) || s.kind !== "section");
  const lines = moved.map(
    (m) => `- ${m.section.heading.replace(/^#+\s*/, "")} → \`${m.relPath}\` (moved ${isoDate(nowMs)}, ${m.reason})\n`,
  );
  const idx = kept.findIndex((s) => s.kind === "index");
  if (idx >= 0) {
    const body = kept[idx].text.endsWith("\n") ? kept[idx].text : kept[idx].text + "\n";
    kept[idx] = { ...kept[idx], text: body + lines.join("") };
  } else {
    const last = kept[kept.length - 1];
    if (last && !last.text.endsWith("\n")) kept[kept.length - 1] = { ...last, text: last.text + "\n" };
    kept.push({
      heading: ARCHIVE_INDEX_HEADING,
      text: `\n${ARCHIVE_INDEX_HEADING}\n\n${ARCHIVE_INDEX_NOTE}\n\n${lines.join("")}`,
      kind: "index",
      historical: false,
      promoted: false,
      pinned: true,
    });
  }
  return kept.map((s) => s.text).join("");
}

export type TidyResult = {
  ranAtMs: number;
  memoryPath: string;
  beforeChars: number;
  afterChars: number;
  moved: Array<{ heading: string; reason: string; chars: number; archivePath: string }>;
  overBudget: boolean;
  backupPath?: string;
  dreamReportsMoved: number;
  dailyNotesMoved: number;
  skipped?: string;
};

function sha(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tidy-tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function uniquePath(file: string): string {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file);
  const base = file.slice(0, -ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/**
 * Move dated files older than retentionDays from srcDir to destDir, keeping
 * names. Returns the count. Only names starting YYYY-MM-DD are considered.
 */
export function moveOldDatedFiles(srcDir: string, destDir: string, retentionDays: number, nowMs: number): number {
  if (retentionDays <= 0) return 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(srcDir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of entries) {
    const m = /^(\d{4})-(\d{2})-(\d{2})\.md$/.exec(name);
    if (!m) continue;
    const dated = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (nowMs - dated <= retentionDays * 86_400_000) continue;
    const dest = uniquePath(path.join(destDir, name));
    try {
      fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(path.join(srcDir, name), dest);
      n++;
    } catch {
      // raced or unreadable — leave it for the next run
    }
  }
  return n;
}

/**
 * Run one tidy pass over a workspace. Never throws. Writes:
 *   - memory/archive/<YYYY-MM-DD>-<slug>.md  (each moved section, verbatim)
 *   - archive/memory-backups/MEMORY.<ts>.md  (pre-change copy, outside the
 *     search index so it does not duplicate hits)
 *   - MEMORY.md rewritten atomically, only if it did not change while we worked
 *   - archive/dreaming/<phase>/<date>.md     (old dream reports, out of index)
 *   - memory/archive/daily/<date>.md         (old daily notes, still indexed)
 */
export function applyTidy(workspaceDir: string, cfg: TidyConfig, nowMs: number): TidyResult {
  const memoryPath = path.join(workspaceDir, "MEMORY.md");
  const result: TidyResult = {
    ranAtMs: nowMs,
    memoryPath,
    beforeChars: 0,
    afterChars: 0,
    moved: [],
    overBudget: false,
    dreamReportsMoved: 0,
    dailyNotesMoved: 0,
  };
  try {
    for (const phase of ["light", "rem", "deep"]) {
      result.dreamReportsMoved += moveOldDatedFiles(
        path.join(workspaceDir, "memory", "dreaming", phase),
        path.join(workspaceDir, "archive", "dreaming", phase),
        cfg.dreamReportRetentionDays,
        nowMs,
      );
    }
    result.dailyNotesMoved = moveOldDatedFiles(
      path.join(workspaceDir, "memory"),
      path.join(workspaceDir, "memory", "archive", "daily"),
      cfg.dailyNoteRetentionDays,
      nowMs,
    );

    let md: string;
    try {
      md = fs.readFileSync(memoryPath, "utf-8");
    } catch {
      result.skipped = "no MEMORY.md";
      return result;
    }
    result.beforeChars = md.length;
    result.afterChars = md.length;
    const plan = planTidy(md, cfg, nowMs);
    result.overBudget = plan.overBudget;
    if (plan.moveSections.length === 0) {
      if (!plan.overBudget) result.skipped = "under budget";
      return result;
    }

    const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(workspaceDir, "archive", "memory-backups", `MEMORY.${stamp}.md`);
    writeAtomic(backupPath, md);
    result.backupPath = backupPath;

    const moved: Array<{ section: Section; relPath: string; reason: string }> = [];
    for (const [i, section] of plan.moveSections.entries()) {
      const reason = plan.moves[i].reason;
      const dated = section.datedMs ?? nowMs;
      const abs = uniquePath(path.join(workspaceDir, "memory", "archive", `${isoDate(dated)}-${slugify(section.heading)}.md`));
      const relPath = path.relative(workspaceDir, abs);
      const header =
        `<!-- Moved verbatim from MEMORY.md on ${isoDate(nowMs)} by sleep-cycle memory tidy ` +
        `(reason: ${reason}). The text below is unchanged. -->\n\n`;
      writeAtomic(abs, header + section.text.replace(/^\n+/, ""));
      moved.push({ section, relPath, reason });
      result.moved.push({ heading: section.heading, reason, chars: section.text.length, archivePath: relPath });
    }

    const next = rewriteMemory(md, moved, nowMs);
    // Optimistic concurrency: the bot may have edited MEMORY.md meanwhile.
    const current = fs.readFileSync(memoryPath, "utf-8");
    if (sha(current) !== sha(md)) {
      for (const m of moved) {
        try {
          fs.unlinkSync(path.join(workspaceDir, m.relPath));
        } catch {
          /* best effort */
        }
      }
      result.moved = [];
      result.skipped = "MEMORY.md changed during tidy; retry next run";
      return result;
    }
    writeAtomic(memoryPath, next);
    result.afterChars = next.length;
    result.overBudget = next.length > cfg.softCapChars;
    return result;
  } catch (err) {
    result.skipped = `error: ${String(err)}`;
    return result;
  }
}

/** Append one JSON line to the tidy log. Best effort. */
export function logTidy(stateDir: string, result: TidyResult): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(path.join(stateDir, "memory-tidy.jsonl"), JSON.stringify(result) + "\n");
  } catch {
    /* best effort */
  }
}

/** Last entry of the tidy log, or undefined when none. */
export function readLastTidy(stateDir: string): TidyResult | undefined {
  try {
    const lines = fs.readFileSync(path.join(stateDir, "memory-tidy.jsonl"), "utf-8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]) as TidyResult;
    return typeof last.ranAtMs === "number" ? last : undefined;
  } catch {
    return undefined;
  }
}

/** Last run time from the tidy log (0 when none). */
export function lastTidyMs(stateDir: string): number {
  return readLastTidy(stateDir)?.ranAtMs ?? 0;
}
