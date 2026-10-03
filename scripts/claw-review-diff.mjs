#!/usr/bin/env node
// ── claw-review-diff (CLAW-091, Level 1 of .swarm/BOT_REPO_CONTRIBUTION_DESIGN.md) ──
//
// Mike asked (2026-07-24, answered in that doc; built 2026-09-04): can a bot
// contribute to the oasis-claw git repo without being able to modify its own
// leash. The doc's Layer 1 (the live checkout stays RO-mounted to every bot)
// already stops IMMEDIATE self-modification and needs no code. This script is
// Layer 2: the human-gated MERGE-TIME check.
//
// It answers one question: does a diff touch any CATEGORY-1 (self-governing)
// path. Category-1 is the exact list from BOT_REPO_CONTRIBUTION_DESIGN.md
// ("Audit findings" section) — this script is now the single source of truth
// for that list; the doc should be read as pointing HERE, not the reverse.
//
// This script does NOT decide whether a category-1 change is acceptable. It
// only says whether one is PRESENT, loudly, so a human decides with eyes open.
// A flagged diff is not necessarily wrong — it might be a legitimate fix a bot
// correctly diagnosed but should not merge unreviewed. Category-1 status is
// about WHO must look, not about right or wrong.
//
// Usage:
//   node scripts/claw-review-diff.mjs <repoPath> [<baseRef> [<compareRef>]]
// Defaults: baseRef="dev", compareRef="HEAD" — i.e. "what does this branch add
// on top of dev". Exits 0 if nothing category-1 changed, 1 if something did,
// 2 on a usage/git error (so a CI failure that means "coudn't check" is never
// silently equivalent to "checked and clean" — a broken check must fail LOUD,
// never open, matching this whole system's fail-closed convention everywhere
// else: relay routing, reviewer policy loads, oasis-find's default-deny).
//
// Zero npm deps: node:child_process + node:path only, same convention as
// claw-mail-relay.mjs and claw-mail-waker.mjs.

import { execFileSync } from "node:child_process";
import { basename, dirname, sep } from "node:path";
import { pathToFileURL } from "node:url";

// ── The category-1 (self-governing) path list ──────────────────────────────
// Verbatim from BOT_REPO_CONTRIBUTION_DESIGN.md "Category-1 (self-governing)
// tracked paths — the protected set" (2026-07-24). Each entry is a matcher
// function over a repo-relative, forward-slash path.
export const CATEGORY_1_RULES = [
  { name: "patches/** (live bind-mount into a running bot's own dist)", test: (p) => p === "patches" || p.startsWith("patches/") },
  { name: "scripts/claw-* (the mail relay, waker, routing, and their config)", test: (p) => dirname(p) === "scripts" && basename(p).startsWith("claw-") },
  { name: "scripts/git-policy/**", test: (p) => p === "scripts/git-policy" || p.startsWith("scripts/git-policy/") },
  { name: "scripts/runtime-entrypoint.sh", test: (p) => p === "scripts/runtime-entrypoint.sh" },
  { name: "scripts/compile-role*", test: (p) => dirname(p) === "scripts" && basename(p).startsWith("compile-role") },
  { name: "scripts/audit-sandbox*", test: (p) => dirname(p) === "scripts" && basename(p).startsWith("audit-sandbox") },
  { name: "sandbox/**", test: (p) => p === "sandbox" || p.startsWith("sandbox/") },
  { name: "Dockerfile.runtime", test: (p) => p === "Dockerfile.runtime" },
  { name: "docker-compose*.yml (any tracked one, any depth)", test: (p) => /^docker-compose.*\.yml$/.test(basename(p)) },
  { name: ".swarm/** (planning + some egress-relevant)", test: (p) => p === ".swarm" || p.startsWith(".swarm/") },
  { name: ".gitignore", test: (p) => basename(p) === ".gitignore" },
  { name: "extensions/** (image-baked; a plugin change is review-gate territory on the NEXT rebuild, not live-immediate — but oasis-reviewer itself lives here)", test: (p) => p === "extensions" || p.startsWith("extensions/") },
];

/** Normalizes a git-reported path to forward slashes (git already emits these
 *  on every platform, but this keeps the matchers platform-independent). */
function normalize(p) {
  return p.split(sep).join("/");
}

/**
 * Classifies a list of repo-relative changed paths against CATEGORY_1_RULES.
 * Pure function, no git/filesystem access — this is what tests exercise
 * directly, so the pattern logic is verifiable without a real git repo.
 */
export function classifyDiff(paths) {
  const flagged = [];
  const clean = [];
  for (const raw of paths) {
    const p = normalize(raw);
    const hit = CATEGORY_1_RULES.find((r) => r.test(p));
    if (hit) flagged.push({ path: p, rule: hit.name });
    else clean.push(p);
  }
  return { flagged, clean };
}

/** Runs `git diff --name-only base...compare` in repoPath. Throws on git error
 *  (a caller-visible failure, never silently treated as "no changes"). */
export function changedPaths(repoPath, baseRef, compareRef) {
  const out = execFileSync("git", ["-C", repoPath, "diff", "--name-only", `${baseRef}...${compareRef}`], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function main() {
  const [repoPath, baseRef = "dev", compareRef = "HEAD"] = process.argv.slice(2);
  if (!repoPath) {
    console.error("usage: node scripts/claw-review-diff.mjs <repoPath> [<baseRef> [<compareRef>]]");
    process.exit(2);
  }
  let paths;
  try {
    paths = changedPaths(repoPath, baseRef, compareRef);
  } catch (err) {
    console.error(`claw-review-diff: git diff failed — treating this as UNREVIEWABLE, not clean: ${String(err?.message ?? err)}`);
    process.exit(2);
  }
  const { flagged, clean } = classifyDiff(paths);
  console.log(`claw-review-diff: ${baseRef}...${compareRef} in ${repoPath}`);
  console.log(`  ${paths.length} changed path(s): ${clean.length} category-2 (product), ${flagged.length} category-1 (self-governing).`);
  if (flagged.length === 0) {
    console.log("  CLEAN — no category-1 path touched. Still needs a human's normal review; this only means the SELF-GOVERNING surface is untouched.");
    process.exit(0);
  }
  console.log("");
  console.log("  ⚠ CATEGORY-1 PATHS CHANGED — requires Mike's explicit sign-off, not routine review:");
  for (const f of flagged) console.log(`    - ${f.path}  [${f.rule}]`);
  process.exit(1);
}

// pathToFileURL, not a raw `file://${...}` template — see CLAW-090 §4 for why
// a raw template silently breaks this check on any path containing a space.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
