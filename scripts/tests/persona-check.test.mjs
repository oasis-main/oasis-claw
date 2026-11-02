// Tests for the persona boot check (scripts/persona-check.mjs).
//
// Load-bearing properties:
//   1. A missing, empty or stock Tier C file, or a BOOTSTRAP.md, holds the
//      boot (exit 3) in enforce mode. Stock means what openclaw itself would
//      write: the template body after its front-matter strip.
//   2. Only a positive finding holds. A missing template folder or a broken
//      lock never holds, so a checker problem cannot stop the fleet.
//   3. The first clean boot pins the hashes. A later change is logged and
//      pinned again (drift=warn) or holds (drift=refuse) until `pin`.
//   4. `pin` never pins a missing or stock persona.
//   5. No output line carries file content.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REFUSE_EXIT, TIER_C, main, normalizeTemplate, runCheck, runPin } from "../persona-check.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "persona-check.mjs");
const SECRET = "persona-line-that-must-never-be-logged";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-check-"));
  const templates = path.join(root, "templates");
  const workspace = path.join(root, "home", "workspace");
  fs.mkdirSync(templates, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  for (const name of TIER_C) {
    // openclaw's templates carry a YAML front-matter block that it strips.
    fs.writeFileSync(path.join(templates, name), `---\nsummary: "stock ${name}"\nread_when:\n  - always\n---\n\n# ${name} stock body\n\nGeneric text.\n`);
  }
  fs.writeFileSync(path.join(templates, "SOUL.dev.md"), "---\nsummary: dev\n---\n# SOUL dev body\n");
  return { root, templates, workspace, lockPath: path.join(root, "home", "persona.lock.json") };
}

function seedPersona(fx) {
  for (const name of TIER_C) fs.writeFileSync(path.join(fx.workspace, name), `# ${name} for this bot\n\n${SECRET}\n`);
}

// What openclaw writes for a missing file: the template after stripFrontMatter.
function writeStock(fx, name, variant = name) {
  const raw = fs.readFileSync(path.join(fx.templates, variant), "utf8");
  fs.writeFileSync(path.join(fx.workspace, name), raw.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^\s+/, ""));
}

const check = (fx, extra = {}) => runCheck({ workspace: fx.workspace, lockPath: fx.lockPath, templateDir: fx.templates, ...extra });

test("normalizeTemplate strips front matter, BOM and CRLF like openclaw", () => {
  assert.equal(normalizeTemplate("﻿---\r\na: 1\r\n---\r\n\r\n# Body\r\n"), "# Body");
  assert.equal(normalizeTemplate("# No front matter\n"), "# No front matter");
  assert.equal(normalizeTemplate("---\nunterminated\n# Body"), "---\nunterminated\n# Body");
});

test("a seeded persona passes and the first boot pins its hashes", () => {
  const fx = fixture();
  seedPersona(fx);
  const r = check(fx);
  assert.equal(r.code, 0);
  const lock = JSON.parse(fs.readFileSync(fx.lockPath, "utf8"));
  assert.equal(lock.version, 1);
  assert.deepEqual(Object.keys(lock.files).sort(), [...TIER_C].sort());
  assert.match(lock.files["SOUL.md"].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(lock.history, []);
  assert.ok(r.lines.some((l) => l.includes("pinned 4 files")));
});

test("a stock template holds the boot in enforce mode", () => {
  const fx = fixture();
  seedPersona(fx);
  writeStock(fx, "SOUL.md");
  const r = check(fx);
  assert.equal(r.code, REFUSE_EXIT);
  assert.deepEqual(r.problems, [{ file: "SOUL.md", reason: "openclaw stock template (SOUL.md)" }]);
  assert.ok(r.lines.some((l) => l.includes("HOLD")));
  assert.equal(fs.existsSync(fx.lockPath), false, "a held boot never pins");
});

test("the .dev.md stock variant also counts as stock", () => {
  const fx = fixture();
  seedPersona(fx);
  writeStock(fx, "SOUL.md", "SOUL.dev.md");
  assert.equal(check(fx).code, REFUSE_EXIT);
});

test("the Van Helsing case (all four stock) holds", () => {
  const fx = fixture();
  for (const name of TIER_C) writeStock(fx, name);
  const r = check(fx);
  assert.equal(r.code, REFUSE_EXIT);
  assert.equal(r.problems.length, 4);
});

test("a missing or empty file holds, and so does BOOTSTRAP.md", () => {
  const fx = fixture();
  seedPersona(fx);
  fs.rmSync(path.join(fx.workspace, "IDENTITY.md"));
  fs.writeFileSync(path.join(fx.workspace, "TOOLS.md"), "\n  \n");
  fs.writeFileSync(path.join(fx.workspace, "BOOTSTRAP.md"), "# first run\n");
  const r = check(fx);
  assert.equal(r.code, REFUSE_EXIT);
  assert.deepEqual(r.problems.map((p) => `${p.file}:${p.reason.split(" ")[0]}`), ["IDENTITY.md:missing", "TOOLS.md:empty", "BOOTSTRAP.md:present"]);
});

test("warn mode logs the same problems but never holds", () => {
  const fx = fixture();
  for (const name of TIER_C) writeStock(fx, name);
  const r = check(fx, { mode: "warn" });
  assert.equal(r.code, 0);
  assert.equal(r.problems.length, 4);
  assert.ok(r.lines.every((l) => !l.includes("REFUSE")));
  assert.equal(fs.existsSync(fx.lockPath), false, "a stock set is never pinned");
});

test("drift=warn records the change and pins again", () => {
  const fx = fixture();
  seedPersona(fx);
  check(fx);
  const before = JSON.parse(fs.readFileSync(fx.lockPath, "utf8"));
  fs.appendFileSync(path.join(fx.workspace, "TOOLS.md"), "a new tool note\n");
  const r = check(fx);
  assert.equal(r.code, 0);
  assert.equal(r.drift.length, 1);
  const after = JSON.parse(fs.readFileSync(fx.lockPath, "utf8"));
  assert.notEqual(after.files["TOOLS.md"].sha256, before.files["TOOLS.md"].sha256);
  assert.equal(after.history.length, 1);
  assert.equal(after.history[0].file, "TOOLS.md");
  assert.equal(after.history[0].from, before.files["TOOLS.md"].sha256);
  // The next boot sees no drift.
  assert.equal(check(fx).drift.length, 0);
});

test("drift=refuse holds until pin accepts the change", () => {
  const fx = fixture();
  seedPersona(fx);
  check(fx);
  fs.appendFileSync(path.join(fx.workspace, "SOUL.md"), "edited\n");
  const held = check(fx, { drift: "refuse" });
  assert.equal(held.code, REFUSE_EXIT);
  assert.ok(held.lines.some((l) => l.includes("persona-check pin")));
  assert.equal(runPin({ workspace: fx.workspace, lockPath: fx.lockPath, templateDir: fx.templates }).code, 0);
  assert.equal(check(fx, { drift: "refuse" }).code, 0);
});

test("pin refuses a stock persona", () => {
  const fx = fixture();
  seedPersona(fx);
  writeStock(fx, "AGENTS.md");
  const r = runPin({ workspace: fx.workspace, lockPath: fx.lockPath, templateDir: fx.templates });
  assert.equal(r.code, REFUSE_EXIT);
  assert.equal(fs.existsSync(fx.lockPath), false);
});

test("no template folder: the stock check is skipped with a warning, never a hold", () => {
  const fx = fixture();
  seedPersona(fx);
  const r = check(fx, { templateDir: path.join(fx.root, "nowhere") });
  assert.equal(r.code, 0);
  assert.ok(r.lines.some((l) => l.includes("stock-template check unavailable")));
});

test("a broken lock is a warning: the boot passes and the lock is written again", () => {
  const fx = fixture();
  seedPersona(fx);
  fs.writeFileSync(fx.lockPath, "{not json");
  const r = check(fx, { drift: "refuse" });
  assert.equal(r.code, 0);
  assert.ok(r.lines.some((l) => l.includes("unreadable lock")));
  assert.equal(JSON.parse(fs.readFileSync(fx.lockPath, "utf8")).version, 1);
});

test("--no-write and status never touch the lock", () => {
  const fx = fixture();
  seedPersona(fx);
  assert.equal(check(fx, { write: false }).code, 0);
  assert.equal(fs.existsSync(fx.lockPath), false);
  const args = ["status", "--workspace", fx.workspace, "--lock", fx.lockPath, "--templates", fx.templates];
  assert.equal(main(args), 0);
  assert.equal(fs.existsSync(fx.lockPath), false);
});

test("CLI: exit 3 on a stock persona, 0 in warn mode, 2 on bad arguments; no content in the output", () => {
  const fx = fixture();
  seedPersona(fx);
  writeStock(fx, "IDENTITY.md");
  const base = ["--workspace", fx.workspace, "--lock", fx.lockPath, "--templates", fx.templates];
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  const held = run(["check", ...base]);
  assert.equal(held.status, REFUSE_EXIT);
  const warned = run(["check", ...base, "--mode", "warn"]);
  assert.equal(warned.status, 0);
  assert.equal(run(["check", ...base, "--mode", "shadow"]).status, 2);
  assert.equal(run(["check", "--bogus"]).status, 2);
  for (const out of [held.stdout, warned.stdout]) {
    assert.ok(!out.includes(SECRET), "persona content leaked into the output");
    assert.ok(!out.includes("stock body"), "template content leaked into the output");
  }
  // --quiet: silent while held, full output once the persona is fixed.
  const quiet = run(["check", ...base, "--quiet"]);
  assert.equal(quiet.status, REFUSE_EXIT);
  assert.equal(quiet.stdout, "");
  fs.writeFileSync(path.join(fx.workspace, "IDENTITY.md"), `# IDENTITY.md for this bot\n\n${SECRET}\n`);
  const cleared = run(["check", ...base, "--quiet"]);
  assert.equal(cleared.status, 0);
  assert.match(cleared.stdout, /pinned 4 files/);
  assert.ok(!cleared.stdout.includes(SECRET));
});
