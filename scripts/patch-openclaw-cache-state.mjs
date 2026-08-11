#!/usr/bin/env node
// Docker-build-time patch for CLAW-083 (fleet-owned bug tracking; not an
// openclaw name). Bug: openclaw's restoreMemoryPluginState (plugin-loader
// cache restore) destructively REPLACES the promptSupplements/
// corpusSupplements arrays on a shared process-global singleton, instead of
// merging by pluginId. Two different plugin-load cache scopes (e.g. a full
// gateway-boot scope vs. a narrower activate:false tool-schema-discovery
// scope, resolvePluginToolRegistry) restore into that SAME singleton at
// different times; whichever scope restores last silently erases every
// plugin id the other scope covers. A "memory"-kind plugin (e.g. memory-core)
// survives because it is present in every scope's snapshot; a generic plugin
// calling registerMemoryPromptSupplement (this fleet's dot-swarm,
// oasis-reach) is not always in the winning scope, so its supplement goes
// silently dark with no error anywhere.
//
// ALREADY FIXED UPSTREAM, NOT YET IN A RELEASE WE CAN ADOPT: fixed
// comprehensively by openclaw/openclaw#117372 ("move plugin contributions
// into the registry bundle", merged 2026-08-01), which deletes the whole
// snapshot/restore-across-scopes pattern this bug lives in. Confirmed present
// from v2026.8.1-beta.1 onward; confirmed ABSENT from v2026.7.2-beta.7 and
// our pinned v2026.7.1-2 (checked 2026-08-11 against
// github.com/openclaw/openclaw). No upstream issue filed — #63157/#65092/
// #65698 already cover the sibling `capability`-field version of this same
// bug class (closed 2026-04-12, predates our pin) and #117372 already
// supersedes any patch we could propose for current source.
//
// REMOVAL PLAN: delete this script and its Dockerfile.runtime call site the
// moment OPENCLAW_VERSION bumps to a release containing #117372. This script
// self-detects that case (see NO-OP case below) so an version bump won't
// silently reintroduce a no-op patch step — but the step should still be
// deleted for real once confirmed, per this repo's own "no dead compat
// shims" convention (see Dockerfile.runtime's "Version history / why").
//
// Patches COMPILED output inside the GLOBAL npm install
// ($(npm root -g)/openclaw/dist/**), not vendor/openclaw/src (a read-only
// reference copy the Dockerfile never consumes — see vendor/openclaw's
// .gitmodules comment). Fails the build loudly on any mismatch rather than
// silently shipping unpatched — this bug class (a fix that appears to apply
// but silently does nothing) is exactly what CLAW-083 already was.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const globalRoot = execSync("npm root -g").toString().trim();
const distDir = `${globalRoot}/openclaw/dist`;

let candidates;
try {
  candidates = execSync(
    `grep -rl "function restoreMemoryPluginState(state)" "${distDir}"`,
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
} catch (err) {
  // grep exits 1 with empty output when no file matches — that IS the
  // "already fixed upstream" case, not a script failure.
  if (err.status === 1 && !err.stdout?.toString().trim()) {
    candidates = [];
  } else {
    throw err;
  }
}

if (candidates.length === 0) {
  console.log(
    "[patch-openclaw-cache-state] no compiled file defines restoreMemoryPluginState — " +
      "openclaw/openclaw#117372's registry-bundle refactor has likely already landed in " +
      "this OPENCLAW_VERSION. Nothing to patch; CLAW-083 should already be fixed natively. " +
      "Delete this script + its Dockerfile.runtime call site once confirmed.",
  );
  process.exit(0);
}

if (candidates.length > 1) {
  console.error(
    `[patch-openclaw-cache-state] expected exactly one compiled file defining ` +
      `restoreMemoryPluginState, found ${candidates.length}: ${candidates.join(", ")}. ` +
      "Refusing to guess which one to patch — failing the build.",
  );
  process.exit(1);
}

const [file] = candidates;
const before = readFileSync(file, "utf8");

const OLD = `function restoreMemoryPluginState(state) {
	memoryPluginState.capability = state.capability ? {
		pluginId: state.capability.pluginId,
		capability: { ...state.capability.capability }
	} : void 0;
	memoryPluginState.corpusSupplements = [...state.corpusSupplements];
	memoryPluginState.promptSupplements = [...state.promptSupplements];
}`;

const NEW = `function mergeMemoryStateSupplementsByPluginId(current, incoming) {
	const merged = new Map(current.map((entry) => [entry.pluginId, entry]));
	for (const entry of incoming) merged.set(entry.pluginId, entry);
	return [...merged.values()];
}
function restoreMemoryPluginState(state) {
	memoryPluginState.capability = state.capability ? {
		pluginId: state.capability.pluginId,
		capability: { ...state.capability.capability }
	} : void 0;
	memoryPluginState.corpusSupplements = mergeMemoryStateSupplementsByPluginId(memoryPluginState.corpusSupplements, state.corpusSupplements);
	memoryPluginState.promptSupplements = mergeMemoryStateSupplementsByPluginId(memoryPluginState.promptSupplements, state.promptSupplements);
}`;

if (!before.includes(OLD)) {
  console.error(
    `[patch-openclaw-cache-state] ${file} does not contain the exact expected ` +
      "restoreMemoryPluginState body. OPENCLAW_VERSION likely changed and this patch text is " +
      "stale relative to it. Refusing to guess or partially apply — failing the build. " +
      "Re-derive the patch against the new compiled output, or delete this step if " +
      "openclaw/openclaw#117372 now covers this OPENCLAW_VERSION (see the no-op case above).",
  );
  process.exit(1);
}

writeFileSync(file, before.replace(OLD, NEW));
console.log(
  `[patch-openclaw-cache-state] patched ${file} — CLAW-083 ` +
    "(restoreMemoryPluginState now merges promptSupplements/corpusSupplements by pluginId " +
    "instead of replacing them)",
);
