import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyTidy,
  ARCHIVE_INDEX_HEADING,
  headingDateMs,
  moveOldDatedFiles,
  planTidy,
  splitSections,
  TIDY_DEFAULTS,
  type TidyConfig,
} from "./src/memory-tidy.js";
import { resolveTranscript } from "./src/session-end.js";

const NOW = Date.UTC(2026, 9, 6, 12); // 2026-10-06
const pad = (n: number) => "x".repeat(n) + "\n";

function fixture(): string {
  return [
    "# MEMORY.md — Test Bot\n",
    "\n## Identity & Setup\n", pad(500),
    "\n## The Book — CURRENT GROUND TRUTH (live pull 2026-10-05)\n", pad(3000),
    "\n## HISTORICAL — Old Account (live pull 2026-09-08)\n", pad(300),
    "### Equity positions\n", pad(3000),
    "### Options\n", pad(3000),
    "\n## Key Macro Framework (Scenarica, Aug 8 2026)\n", pad(1000),
    "\n## Action Queue (ordered, as of Aug 10 2026)\n", pad(1000),
    "\n## Signal Calendar\n", pad(4000),
    "\n## Take-Profit Protocol v2 (Mike, 2026-10-05) — SUPERSEDES the old ladder\n", pad(2000),
    "\n## Pinned Thesis (2026-07-01)\n<!-- pin -->\n", pad(1500),
    "\n## Promoted From Short-Term Memory (2026-09-01)\n", pad(1200),
    "\n## Notes on Mike\n", pad(600),
    "\n## Options Exit Discipline (Mike, 2026-07-23)\n", pad(50),
    "\n## Peer Request Paging Protocol (Mike's Rule, added 2026-07-08)\n", pad(50),
  ].join("");
}

const CFG: TidyConfig = { ...TIDY_DEFAULTS };

describe("splitSections", () => {
  it("round-trips the input byte for byte and keeps ### with its parent", () => {
    const md = fixture();
    const sections = splitSections(md);
    expect(sections.map((s) => s.text).join("")).toBe(md);
    const hist = sections.find((s) => s.heading.startsWith("## HISTORICAL"))!;
    expect(hist.text).toContain("### Equity positions");
    expect(hist.text).toContain("### Options");
    expect(sections[0].kind).toBe("preamble");
  });

  it("does not split on ## inside a fenced block", () => {
    const md = "# T\n\n## A\n```\n## not a heading\n```\n\n## B\nb\n";
    expect(splitSections(md).map((s) => s.heading)).toEqual(["", "## A", "## B"]);
  });
});

describe("headingDateMs", () => {
  it("reads ISO, month-name and picks the newest date", () => {
    expect(headingDateMs("## X (2026-09-08)")).toBe(Date.UTC(2026, 8, 8));
    expect(headingDateMs("## X (Scenarica, Aug 8 2026)")).toBe(Date.UTC(2026, 7, 8));
    expect(headingDateMs("## X (September 23, 2026)")).toBe(Date.UTC(2026, 8, 23));
    expect(headingDateMs("## X 2026-07-01 then 2026-08-02")).toBe(Date.UTC(2026, 7, 2));
    expect(headingDateMs("## Signal Calendar")).toBeUndefined();
  });
});

describe("planTidy", () => {
  it("does nothing under the soft cap", () => {
    const plan = planTidy("# small\n\n## HISTORICAL x (2020-01-01)\nabc\n", CFG, NOW);
    expect(plan.moves).toEqual([]);
    expect(plan.overBudget).toBe(false);
  });

  it("moves HISTORICAL first, then stale promoted, then stale dated, oldest first, until under target", () => {
    const md = fixture();
    expect(md.length).toBeGreaterThan(CFG.softCapChars);
    const plan = planTidy(md, CFG, NOW);
    // moves are reported in file order; the selection follows tier priority
    const byReason = Object.fromEntries(plan.moves.map((m) => [m.reason, m.heading]));
    expect(Object.keys(byReason).sort()).toEqual(["dated-stale", "historical", "promoted-stale"]);
    expect(byReason["historical"]).toMatch(/^## HISTORICAL/);
    expect(byReason["promoted-stale"]).toMatch(/^## Promoted From Short-Term Memory/);
    expect(byReason["dated-stale"]).toMatch(/Aug 8 2026/); // older of the two dated sections
    expect(plan.moves.some((m) => m.heading.includes("Aug 10 2026"))).toBe(false);
    expect(plan.afterChars).toBeLessThanOrEqual(CFG.targetChars);
  });

  it("never moves pinned, identity, CURRENT, SUPERSEDES or undated sections", () => {
    const plan = planTidy(fixture(), { ...CFG, softCapChars: 1000, targetChars: 0 }, NOW);
    const moved = plan.moves.map((m) => m.heading).join("\n");
    for (const kept of ["Identity", "CURRENT GROUND TRUTH", "SUPERSEDES", "Pinned Thesis", "Notes on Mike", "Signal Calendar", "Exit Discipline", "Paging Protocol"]) {
      expect(moved).not.toContain(kept);
    }
    expect(plan.overBudget).toBe(true);
  });

  it("reports overBudget when nothing is movable", () => {
    const md = "# T\n\n## Signal Calendar\n" + pad(20_000);
    const plan = planTidy(md, CFG, NOW);
    expect(plan.moves).toEqual([]);
    expect(plan.overBudget).toBe(true);
  });
});

function tmpWorkspace(md: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tidy-"));
  fs.writeFileSync(path.join(dir, "MEMORY.md"), md);
  return dir;
}

describe("applyTidy", () => {
  it("moves sections verbatim, backs up, and leaves pointers", () => {
    const md = fixture();
    const ws = tmpWorkspace(md);
    const res = applyTidy(ws, CFG, NOW);
    expect(res.skipped).toBeUndefined();
    expect(res.moved.length).toBe(3);
    const after = fs.readFileSync(path.join(ws, "MEMORY.md"), "utf-8");
    expect(after.length).toBe(res.afterChars);
    expect(after.length).toBeLessThan(md.length);
    expect(after).toContain(ARCHIVE_INDEX_HEADING);
    // backup is the exact original, outside memory/ (not indexed)
    expect(res.backupPath).toContain(`${path.sep}archive${path.sep}memory-backups${path.sep}`);
    expect(fs.readFileSync(res.backupPath!, "utf-8")).toBe(md);
    // every moved section's text is in its archive file byte for byte
    const sections = splitSections(md);
    for (const m of res.moved) {
      expect(m.archivePath.startsWith(`memory${path.sep}archive${path.sep}`)).toBe(true);
      const archived = fs.readFileSync(path.join(ws, m.archivePath), "utf-8");
      const original = sections.find((s) => s.heading === m.heading)!.text.replace(/^\n+/, "");
      expect(archived.endsWith(original)).toBe(true);
      expect(after).toContain(`\`${m.archivePath}\``);
      expect(after).not.toContain(m.heading + "\n");
    }
    // no text was lost: kept sections + archived sections == original sections
    const keptHeadings = splitSections(after).map((s) => s.heading);
    for (const s of sections) {
      const wasMoved = res.moved.some((m) => m.heading === s.heading);
      expect(wasMoved || keptHeadings.includes(s.heading)).toBe(true);
    }
  });

  it("is idempotent: a second run appends to the same index and moves nothing new under budget", () => {
    const ws = tmpWorkspace(fixture());
    applyTidy(ws, CFG, NOW);
    const once = fs.readFileSync(path.join(ws, "MEMORY.md"), "utf-8");
    const res2 = applyTidy(ws, CFG, NOW);
    expect(res2.moved).toEqual([]);
    expect(fs.readFileSync(path.join(ws, "MEMORY.md"), "utf-8")).toBe(once);
    expect(once.split(ARCHIVE_INDEX_HEADING).length).toBe(2);
  });

  it("skips without writing MEMORY.md when there is no MEMORY.md", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tidy-"));
    expect(applyTidy(ws, CFG, NOW).skipped).toBe("no MEMORY.md");
  });
});

describe("moveOldDatedFiles", () => {
  it("moves only dated files older than retention", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "dated-"));
    const dest = path.join(src, "out");
    for (const n of ["2026-08-01.md", "2026-10-01.md", "notes.md", "2026-08-02.txt"]) {
      fs.writeFileSync(path.join(src, n), n);
    }
    expect(moveOldDatedFiles(src, dest, 14, NOW)).toBe(1);
    expect(fs.readdirSync(dest)).toEqual(["2026-08-01.md"]);
    expect(fs.existsSync(path.join(src, "2026-10-01.md"))).toBe(true);
    expect(moveOldDatedFiles(src, dest, 0, NOW)).toBe(0);
  });
});

describe("resolveTranscript", () => {
  it("finds the .reset. archive when the live file was renamed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
    const live = path.join(dir, "abc.jsonl");
    fs.writeFileSync(`${live}.reset.2026-10-06T03-00-00.000Z`, "{}\n");
    expect(resolveTranscript(live)).toBe(`${live}.reset.2026-10-06T03-00-00.000Z`);
    fs.writeFileSync(live, "{}\n");
    expect(resolveTranscript(live)).toBe(live);
    expect(resolveTranscript(undefined)).toBeUndefined();
  });
});
