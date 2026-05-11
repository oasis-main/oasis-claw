/**
 * One-shot sandbox auditor — runs the clawhub-skill-audit pipeline against
 * the quarantined skills in vendor/sandbox-skill-audit/.
 *
 * Modes:
 *   (default)            DRY-RUN. Snapshot + write prompt to disk. No API spend.
 *   --live               Single-turn audit; verdict via emit_audit only.
 *   --live --inspect     Multi-turn audit. Auditor can call inspect_file to
 *                        read the openclaw plugin/extension source code that
 *                        the skill delegates to.
 *
 * `--inspect` requires an openclaw source tree on disk. The script will
 * shallow-clone openclaw/openclaw into vendor/openclaw-source/ on first run
 * if it's not already present (~30MB, takes ~10s).
 *
 * Run via the bootstrap so the .js→.ts resolver hook is in effect:
 *   node --experimental-strip-types scripts/audit-sandbox.mjs [--live] [--inspect]
 *
 * This script has NO inline copy of the audit prompt, tool schema, or
 * multi-turn loop. All of that is imported from the audit extension's
 * source. See scripts/ts-resolver-hook.mjs for how the .js suffixes in
 * the audit extension's NodeNext-style imports are resolved.
 */
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { findAllSkills } from "../extensions/clawhub-skill-audit/src/skill-scanner.ts";
import { runAudit, type AuditVerdict, type UnauditedPath } from "../extensions/clawhub-skill-audit/src/auditor.ts";
import { Inspector, DEFAULT_AUDITABLE_EXT } from "../extensions/clawhub-skill-audit/src/inspector.ts";
import {
  AUDITOR_SYSTEM_PROMPT,
  buildAuditUserPrompt,
} from "../extensions/clawhub-skill-audit/src/audit-prompt.ts";

// ────────────────────────────── openclaw mirror (for inspect roots) ──────────────────────────────
function ensureOpenclawSource(repoRoot: string): string | null {
  // Shallow-clone openclaw/openclaw under vendor/openclaw-source the first time
  // we need it. Subsequent runs reuse the cache. Returns the path to the
  // extensions/ dir which becomes the auditor's inspect root.
  const cloneDir = path.join(repoRoot, "vendor", "openclaw-source");
  const extensionsDir = path.join(cloneDir, "extensions");
  if (fs.existsSync(extensionsDir)) {
    return extensionsDir;
  }
  console.log(`  → openclaw source not cached; shallow-cloning into ${path.relative(repoRoot, cloneDir)} (≈30MB)…`);
  fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
  const r = spawnSync(
    "git",
    ["clone", "--depth=1", "--single-branch", "https://github.com/openclaw/openclaw.git", cloneDir],
    { stdio: "inherit" },
  );
  if (r.status !== 0) {
    console.error(`  → git clone failed (status ${r.status})`);
    return null;
  }
  if (!fs.existsSync(extensionsDir)) {
    console.error(`  → expected ${extensionsDir} after clone, not present`);
    return null;
  }
  return extensionsDir;
}

// ────────────────────────────── pretty-print helpers ──────────────────────────────
function printVerdict(v: AuditVerdict): void {
  console.log(
    `  verdict: ${v.verdict}  risk=${v.risk_score}  findings=${v.findings.length}  ` +
      `pct_visible=${v.coverage.pct_visible}  ${v.latencyMs}ms`,
  );
  console.log(`  summary: ${v.summary.slice(0, 240)}`);
  for (const f of v.findings.slice(0, 8)) {
    console.log(`    [${f.severity}/${f.category}] ${f.file} — ${f.detail.slice(0, 200)}`);
  }
  if (v.coverage.unaudited_paths.length > 0) {
    const order: Record<UnauditedPath["severity"], number> = { high: 0, medium: 1, low: 2, info: 3 };
    const sorted = [...v.coverage.unaudited_paths].sort((a, b) => order[a.severity] - order[b.severity]);
    console.log(`  unaudited paths (${sorted.length}):`);
    for (const u of sorted) {
      console.log(`    [${u.severity}] ${u.path}  — ${u.reason.slice(0, 120)}`);
    }
  }
  if (v.inspections.length > 0) {
    console.log(`  inspections (${v.inspections.length}):`);
    for (const insp of v.inspections) {
      const status = insp.ok ? `${insp.bytesReturned}B${insp.truncated ? " TRUNC" : ""}` : `ERR: ${insp.errorDetail}`;
      console.log(`    [${insp.ok ? "✓" : "✗"}] ${insp.requestedPath}  ${status}  — ${insp.reason.slice(0, 80)}`);
    }
  }
}

// ────────────────────────────── main ──────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sandboxRoot = path.join(repoRoot, "vendor/sandbox-skill-audit");
const live = process.argv.includes("--live");
const inspect = process.argv.includes("--inspect");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const onlyId = onlyArg ? onlyArg.slice("--only=".length) : null;
const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
const model = process.env.AUDIT_MODEL ?? "claude-opus-4-7";

const metaDir = path.join(sandboxRoot, "_meta");
fs.mkdirSync(metaDir, { recursive: true });

let inspectorRoot: string | null = null;
if (inspect) {
  if (!live) {
    console.error("--inspect requires --live (inspection happens via Anthropic API tool calls)");
    process.exit(2);
  }
  inspectorRoot = ensureOpenclawSource(repoRoot);
  if (!inspectorRoot) {
    console.error("--inspect was requested but openclaw source is unavailable. Aborting.");
    process.exit(2);
  }
}

const allSkills = findAllSkills([sandboxRoot], { maxBytesPerFile: 65_536, maxFilesPerSkill: 25 });
const skills = onlyId ? allSkills.filter((s) => s.skillId === onlyId) : allSkills;
if (allSkills.length === 0) {
  console.error(`No skills under ${sandboxRoot}`);
  process.exit(1);
}
if (onlyId && skills.length === 0) {
  console.error(`--only=${onlyId} matched no skills (have: ${allSkills.map((s) => s.skillId).join(", ")})`);
  process.exit(1);
}
console.log(`Found ${allSkills.length} skill(s) under ${sandboxRoot}${onlyId ? ` — auditing only '${onlyId}'` : ""}`);
console.log(`Mode: ${live ? "LIVE" : "DRY-RUN"}${inspect ? " + INSPECT" : ""}  Model: ${live ? model : "(not called)"}`);
if (inspectorRoot) console.log(`Inspect root: ${path.relative(repoRoot, inspectorRoot)}`);
console.log(`Metadata → ${path.relative(repoRoot, metaDir)} (kept out of snapshot scope)\n`);

for (const snap of skills) {
  console.log(`━━━ ${snap.skillId} ━━━`);
  console.log(`  baseDir:     ${path.relative(repoRoot, snap.baseDir)}`);
  console.log(`  contentHash: ${snap.contentHash}`);
  console.log(`  files (${snap.files.length}):`);
  for (const f of snap.files) console.log(`    - ${f.relPath}  ${f.size}B${f.truncated ? " TRUNC" : ""}`);
  if (snap.externalRefs.length > 0) {
    console.log(`  externalRefs (${snap.externalRefs.length}):`);
    for (const r of snap.externalRefs) console.log(`    - ${r}`);
  }

  // Per-skill inspector. Budget: 10 files, 512KB total, 96KB per file.
  // Bumped from 32KB→96KB per-file because pw-tools-core.interactions.ts
  // (the browser plugin's evaluate gating) is ~100KB and was being
  // truncated mid-file, hiding the gating wrapper from the auditor
  // (CLAW-014 evaluate-slice audit, 2026-05-09). Total bumped 256→512KB
  // proportionally.
  const inspector = inspectorRoot
    ? new Inspector({
        inspectRoots: [inspectorRoot],
        maxFiles: 10,
        maxTotalBytes: 512 * 1024,
        maxBytesPerFile: 96 * 1024,
        auditableExt: DEFAULT_AUDITABLE_EXT,
      })
    : null;

  // Render the prompt once for the on-disk audit-input.txt artifact (so a
  // human can review what the auditor sees without paying for an API call).
  // Uses the SAME builder as runAudit() — single source of truth.
  const promptPath = path.join(metaDir, `${snap.skillId}.audit-input.txt`);
  const promptText =
    `=== SYSTEM ===\n${AUDITOR_SYSTEM_PROMPT}\n\n=== USER ===\n` +
    buildAuditUserPrompt({
      skillId: snap.skillId,
      files: snap.files,
      coverage: { audited_files: snap.files.length, declared_external_refs: snap.externalRefs },
      inspection: inspector
        ? {
            rootLabels: inspector.rootLabels(),
            maxFiles: inspector.remainingBudget().files,
            maxTotalBytes: inspector.remainingBudget().bytes,
            maxBytesPerFile: inspector.perFileBudget(),
          }
        : null,
    }) +
    "\n";
  fs.writeFileSync(promptPath, promptText);
  console.log(`  prompt → ${path.relative(repoRoot, promptPath)} (${promptText.length} chars)`);

  if (!live) { console.log(""); continue; }
  if (!apiKey) { console.error(`  ERROR: --live requires ANTHROPIC_API_KEY`); process.exit(2); }

  console.log(`  → calling ${model}${inspect ? " (multi-turn)" : ""}…`);
  const verdict = await runAudit(snap, { apiKey, model, inspector: inspector ?? undefined });
  fs.writeFileSync(path.join(metaDir, `${snap.skillId}.audit-verdict.json`), JSON.stringify(verdict, null, 2));
  printVerdict(verdict);
  console.log("");
}
