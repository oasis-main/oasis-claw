#!/usr/bin/env node
// persona-check — the persona boot check (Mike, 2026-11-02; step 1 of the
// identity plan).
//
// WHY. From 2026-10-14 to 2026-11-02 Van Helsing ran on openclaw's stock
// workspace templates. The sandbox prune `rm -rf`'d the shared workspace, and
// on a later turn openclaw's ensureAgentWorkspace wrote the stock AGENTS, SOUL,
// IDENTITY and TOOLS .md into the empty folder. Nothing failed, nothing logged,
// and the bot answered as a generic assistant for 19 days. The container was
// recreated on 2026-10-25 with the stock files in place: a boot check would
// have caught it that day.
//
// WHAT. The entrypoint runs `persona-check check` before anything else. The
// check reads the four constitution files (Tier C) and refuses the boot when:
//   - a Tier C file is missing or empty,
//   - a Tier C file is byte-for-byte openclaw's stock template (after the same
//     front-matter strip openclaw applies when it writes one),
//   - BOOTSTRAP.md is present (openclaw's first-run script, which tells the
//     agent to write a new identity: a Tier C change without Mike),
//   - with --drift refuse: a Tier C hash differs from the pinned hash.
// A refusal does not crash the container. The entrypoint holds before the
// gateway starts and runs the check again every 15 s, so `make -C bots
// BOT=<bot> seed` (copy + restart) or `persona-check pin` clears it. The
// healthcheck marks a held container unhealthy, so the observatory shows it.
//
// PIN. The first clean boot writes persona.lock.json (hashes and sizes only)
// in the volume root, outside workspace/, so the sandbox mount (which mounts
// only the workspace subpath) cannot delete it with the persona. With
// --drift warn (the default) a changed file is logged, recorded in the lock's
// history and pinned again. Tier C sign-off (step 3) replaces this lock with a
// signed manifest.
//
// FAIL OPEN ON OUR OWN BUGS. Only a positive finding holds the boot. If this
// script throws, cannot find the templates or cannot read the lock, it says so
// and exits non-3, and the entrypoint boots normally. A checker failure is not
// a bot failure, so one bug here cannot hold the whole fleet.
//
// No file content is ever printed: only names, sizes and SHA-256 prefixes.
//
// Exit codes: 0 pass (or warn mode), 3 refuse, 2 usage, other = checker error.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TIER_C = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "TOOLS.md"];
export const BOOTSTRAP_FILE = "BOOTSTRAP.md";
export const REFUSE_EXIT = 3;
export const LOCK_VERSION = 1;
export const HISTORY_MAX = 20;

const DEFAULT_CONFIG_DIR = "/home/node/.openclaw";
// openclaw 2026.7.1-2 loads workspace templates from <package>/docs/reference/
// templates (workspace-templates.ts resolveWorkspaceTemplateSearchDirs).
export const TEMPLATE_DIR_CANDIDATES = [
  "/usr/local/lib/node_modules/openclaw/docs/reference/templates",
  "/usr/lib/node_modules/openclaw/docs/reference/templates",
];

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const short = (hex) => (hex ? hex.slice(0, 12) : "-");

// The same normalization openclaw's stripFrontMatter applies before it writes
// a template (packages/markdown-core/src/frontmatter.ts: BOM, CRLF, a leading
// `---` block), then trimmed on both ends so a trailing newline from an editor
// or `compose cp` does not hide a stock file.
export function normalizeTemplate(text) {
  let s = String(text).replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = s.split("\n");
  if (lines.length > 1 && lines[0].trimEnd() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
    if (end > 0) s = lines.slice(end + 1).join("\n");
  }
  return s.trim();
}

export function resolveTemplateDir(explicit) {
  const candidates = explicit ? [explicit] : TEMPLATE_DIR_CANDIDATES;
  return candidates.find((dir) => fs.existsSync(path.join(dir, "AGENTS.md"))) ?? null;
}

// name -> list of normalized stock bodies (the plain and the .dev.md variant).
export function loadStockTemplates(templateDir) {
  const stock = new Map();
  if (!templateDir) return stock;
  for (const name of TIER_C) {
    const bodies = [];
    for (const variant of [name, name.replace(/\.md$/, ".dev.md")]) {
      try {
        bodies.push({ variant, body: normalizeTemplate(fs.readFileSync(path.join(templateDir, variant), "utf8")) });
      } catch {
        // A missing variant is normal (not every file has a .dev.md).
      }
    }
    stock.set(name, bodies);
  }
  return stock;
}

export function inspectWorkspace(workspace, stock) {
  const files = {};
  for (const name of TIER_C) {
    let buf;
    try {
      buf = fs.readFileSync(path.join(workspace, name));
    } catch {
      files[name] = { present: false };
      continue;
    }
    const text = buf.toString("utf8");
    const normalized = normalizeTemplate(text);
    const match = (stock.get(name) ?? []).find((t) => t.body === normalized);
    files[name] = {
      present: true,
      bytes: buf.length,
      sha256: sha256(buf),
      empty: normalized.length === 0,
      stock: match ? match.variant : null,
    };
  }
  return { files, bootstrapPresent: fs.existsSync(path.join(workspace, BOOTSTRAP_FILE)) };
}

export function readLock(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return { lock: null, error: null };
  }
  try {
    const lock = JSON.parse(raw);
    if (lock?.version !== LOCK_VERSION || typeof lock.files !== "object" || !lock.files) {
      return { lock: null, error: "unknown lock format" };
    }
    return { lock, error: null };
  } catch (err) {
    return { lock: null, error: `unreadable lock (${err.message})` };
  }
}

// Pure: decide from an inspection and the pinned lock. `problems` hold the
// boot (in enforce mode); `drift` holds it only with drift=refuse.
export function evaluate(inspection, lock) {
  const problems = [];
  for (const name of TIER_C) {
    const f = inspection.files[name];
    if (!f.present) problems.push({ file: name, reason: "missing" });
    else if (f.empty) problems.push({ file: name, reason: "empty" });
    else if (f.stock) problems.push({ file: name, reason: `openclaw stock template (${f.stock})` });
  }
  if (inspection.bootstrapPresent) {
    problems.push({ file: BOOTSTRAP_FILE, reason: "present (openclaw first-run script; it tells the agent to write a new identity)" });
  }
  const drift = [];
  if (lock) {
    for (const name of TIER_C) {
      const f = inspection.files[name];
      const pinned = lock.files[name]?.sha256 ?? null;
      if (f.present && pinned && f.sha256 !== pinned) drift.push({ file: name, from: pinned, to: f.sha256 });
    }
  }
  return { problems, drift };
}

export function buildLock(inspection, previous, now = new Date()) {
  const at = now.toISOString();
  const files = {};
  for (const name of TIER_C) {
    const f = inspection.files[name];
    files[name] = { sha256: f.sha256, bytes: f.bytes };
  }
  const history = [...(previous?.history ?? [])];
  for (const name of TIER_C) {
    const from = previous?.files?.[name]?.sha256 ?? null;
    if (from && from !== files[name].sha256) history.push({ at, file: name, from, to: files[name].sha256 });
  }
  return {
    version: LOCK_VERSION,
    pinnedAt: at,
    files,
    history: history.slice(-HISTORY_MAX),
  };
}

export function writeLock(lockPath, lock) {
  const tmp = `${lockPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(tmp, lockPath);
}

// One full check. Returns { code, lines } so tests need no subprocess.
//   mode:  enforce | warn   (off is handled by the entrypoint, never reaches here)
//   drift: warn | refuse
//   write: false = never touch the lock (status runs, read-only mounts)
export function runCheck({ workspace, lockPath, templateDir, mode = "enforce", drift = "warn", write = true, now }) {
  const lines = [];
  const say = (s) => lines.push(`[persona] ${s}`);
  const resolvedTemplates = resolveTemplateDir(templateDir);
  if (!resolvedTemplates) say("WARN stock-template check unavailable: openclaw template folder not found");
  const inspection = inspectWorkspace(workspace, loadStockTemplates(resolvedTemplates));
  const { lock, error: lockError } = readLock(lockPath);
  if (lockError) say(`WARN ${lockError} at ${lockPath}; pinning again`);

  for (const name of TIER_C) {
    const f = inspection.files[name];
    say(f.present ? `${name} ${f.bytes} B sha256:${short(f.sha256)}` : `${name} missing`);
  }

  const { problems, drift: changed } = evaluate(inspection, lock);
  const refuseDrift = drift === "refuse" && changed.length > 0;
  for (const p of problems) say(`${mode === "enforce" ? "REFUSE" : "WARN"} ${p.file}: ${p.reason}`);
  for (const d of changed) {
    say(`${drift === "refuse" ? "REFUSE" : "WARN"} ${d.file} changed since the pin: sha256:${short(d.from)} -> sha256:${short(d.to)}`);
  }

  const hold = mode === "enforce" && (problems.length > 0 || refuseDrift);
  if (hold) {
    if (problems.length > 0) {
      say(`HOLD: the gateway does not start on a missing or stock persona. Fix: make -C bots BOT=<bot> seed (in ${workspace}).`);
    } else {
      say("HOLD: a persona file changed and OASIS_PERSONA_DRIFT=refuse. If the change is yours: docker exec <container> persona-check pin");
    }
    return { code: REFUSE_EXIT, lines, inspection, problems, drift: changed };
  }

  // Pin on the first clean boot, and again after a warned drift (the change
  // goes into the lock's history). Never pin a set that has problems.
  if (write && problems.length === 0 && (!lock || changed.length > 0)) {
    writeLock(lockPath, buildLock(inspection, lock, now));
    say(lock ? `pinned again (${changed.length} change(s) recorded in ${lockPath})` : `pinned ${TIER_C.length} files in ${lockPath}`);
  }
  if (problems.length === 0 && !refuseDrift) say("ok");
  return { code: 0, lines, inspection, problems, drift: changed };
}

export function runPin({ workspace, lockPath, templateDir, now }) {
  const lines = [];
  const inspection = inspectWorkspace(workspace, loadStockTemplates(resolveTemplateDir(templateDir)));
  const { problems } = evaluate(inspection, null);
  if (problems.length > 0) {
    for (const p of problems) lines.push(`[persona] REFUSE ${p.file}: ${p.reason}`);
    lines.push("[persona] will not pin a missing or stock persona. Seed the bot first.");
    return { code: REFUSE_EXIT, lines };
  }
  const { lock } = readLock(lockPath);
  writeLock(lockPath, buildLock(inspection, lock, now));
  lines.push(`[persona] pinned ${TIER_C.length} files in ${lockPath}`);
  return { code: 0, lines };
}

function parseArgs(argv) {
  const [command = "check", ...rest] = argv;
  const opts = { command };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = () => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--workspace") opts.workspace = value();
    else if (arg === "--lock") opts.lockPath = value();
    else if (arg === "--templates") opts.templateDir = value();
    else if (arg === "--mode") opts.mode = value();
    else if (arg === "--drift") opts.drift = value();
    else if (arg === "--no-write") opts.write = false;
    else if (arg === "--quiet") opts.quiet = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

export function main(argv, env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`[persona] usage: persona-check check|pin|status [--workspace DIR] [--lock FILE] [--templates DIR] [--mode enforce|warn] [--drift warn|refuse] [--no-write] [--quiet] (${err.message})`);
    return 2;
  }
  const configDir = env.OPENCLAW_CONFIG_DIR || DEFAULT_CONFIG_DIR;
  const workspace = opts.workspace ?? path.join(configDir, "workspace");
  const lockPath = opts.lockPath ?? path.join(configDir, "persona.lock.json");
  const templateDir = opts.templateDir ?? env.OASIS_PERSONA_TEMPLATES ?? undefined;
  const mode = (opts.mode ?? "enforce").toLowerCase();
  const drift = (opts.drift ?? "warn").toLowerCase();
  if (!["enforce", "warn"].includes(mode) || !["warn", "refuse"].includes(drift)) {
    console.error(`[persona] bad --mode ${mode} or --drift ${drift}`);
    return 2;
  }

  let result;
  if (opts.command === "check") {
    result = runCheck({ workspace, lockPath, templateDir, mode, drift, write: opts.write !== false });
  } else if (opts.command === "status") {
    result = runCheck({ workspace, lockPath, templateDir, mode, drift, write: false });
  } else if (opts.command === "pin") {
    result = runPin({ workspace, lockPath, templateDir });
  } else {
    console.error(`[persona] unknown command ${opts.command}`);
    return 2;
  }
  // --quiet (the entrypoint's re-checks while it holds, every 15 s): silent
  // while the hold goes on; the entrypoint prints the full check every 10 min.
  // A pass prints in full, so the log shows what cleared the hold.
  const lines = opts.quiet && result.code === REFUSE_EXIT ? [] : result.lines;
  for (const line of lines) console.log(line);
  return result.code;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`[persona] checker error, boot continues: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}
