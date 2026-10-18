#!/usr/bin/env node
// Docker-build-time patch: make the plugin runtime's llm.complete() return
// WHY a reply came back empty.
//
// Bug: openclaw's createRuntimeLlm().complete() (the API behind
// api.runtime.llm.complete, used by oasis-reviewer's Layer 2 judge) returns
// only { text, provider, model, agentId, usage, audit }. It drops the
// underlying AssistantMessage's stopReason and errorMessage. The transport
// does NOT throw on a provider-side stop such as finish_reason
// "content_filter": it sets stopReason "error" and errorMessage "Provider
// finish_reason: content_filter", leaves content empty, and complete()
// resolves with text "". The caller therefore sees an empty string with no
// reason at all.
//
// Incident (2026-10-17): Nimbus's reviewer denied 4 reach_send calls with
// "constitution could not be evaluated (unparseable verdict)". A replay
// through Bedrock showed stopReason "content_filtered" with 0 output tokens
// on every try. Nothing in the audit could say so, because of this drop.
//
// The patch adds two fields to the returned object: stopReason (always) and
// errorMessage (when set). Additive only; existing callers ignore them.
//
// Patches COMPILED output inside the GLOBAL npm install, same approach and
// same fail-loud rule as patch-openclaw-cache-state.mjs: any mismatch fails
// the build instead of shipping unpatched. If a future OPENCLAW_VERSION
// already returns stopReason, the script is a no-op and says so; delete it
// and its Dockerfile.runtime call site then.
//
// OASIS_PATCH_DIST overrides the dist directory (for testing on a copy).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const TAG = "[patch-openclaw-llm-stop-reason]";
const distDir =
  process.env.OASIS_PATCH_DIST || `${execSync("npm root -g").toString().trim()}/openclaw/dist`;

let candidates;
try {
  candidates = execSync(`grep -rl "function createRuntimeLlm(" "${distDir}"`, { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((f) => f.endsWith(".js"));
} catch (err) {
  if (err.status === 1 && !err.stdout?.toString().trim()) candidates = [];
  else throw err;
}

if (candidates.length !== 1) {
  console.error(
    `${TAG} expected exactly one compiled file defining createRuntimeLlm, found ` +
      `${candidates.length}: ${candidates.join(", ")}. Refusing to guess — failing the build.`,
  );
  process.exit(1);
}

const [file] = candidates;
const before = readFileSync(file, "utf8");

const OLD = `		return {
			text,
			provider: prepared.selection.provider,`;
const NEW = `		return {
			text,
			stopReason: result.stopReason,
			...result.errorMessage ? { errorMessage: result.errorMessage } : {},
			provider: prepared.selection.provider,`;

if (before.includes(NEW)) {
  console.log(`${TAG} ${file} already patched — nothing to do`);
  process.exit(0);
}
if (/return \{\s*text,\s*stopReason/.test(before)) {
  console.log(
    `${TAG} ${file} already returns stopReason natively — this OPENCLAW_VERSION fixed it. ` +
      "Delete this script and its Dockerfile.runtime call site.",
  );
  process.exit(0);
}
const hits = before.split(OLD).length - 1;
if (hits !== 1) {
  console.error(
    `${TAG} ${file} has ${hits} copies of the expected return block (want 1). ` +
      "OPENCLAW_VERSION likely changed the compiled shape. Refusing to guess — failing the build.",
  );
  process.exit(1);
}

writeFileSync(file, before.replace(OLD, NEW));
console.log(`${TAG} patched ${file} — runtime.llm.complete() now returns stopReason/errorMessage`);
