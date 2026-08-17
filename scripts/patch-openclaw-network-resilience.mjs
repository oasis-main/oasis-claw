#!/usr/bin/env node
// Docker-build-time patch for CLAW-099 (fleet-owned bug tracking; not an
// openclaw name). Bug, part 1 (primary fix — always applied): openclaw's
// src/infra/unhandled-rejections.ts installs a process-wide
// `unhandledRejection` handler that calls process.exit(1) on any rejection
// whose error does NOT match isTransientNetworkError's allow-list (POSIX
// codes like ECONNRESET/ETIMEDOUT, error names like AbortError, message
// snippets like "socket hang up"/"getaddrinfo"). The TUI's own gateway
// client (packages/gateway-client/src/client.ts, compiled into this
// package's dist/src-DZzKBMa7.js) throws its own hand-rolled Error objects
// for real network-drop conditions that do NOT appear on that allow-list:
// the literal message "gateway not connected" (client.ts request()/
// requestOnSocket() when the socket isn't OPEN), the prefix "gateway
// request timeout for " followed by a method name (requestOnSocket()'s
// per-request timeout), and the prefix "gateway closed (" followed by a
// close code and reason (the close handler's flushPendingErrors() call). If
// any of these three ever end up as an unhandled rejection (e.g. a caller
// forgets to .catch() a gateway request made during a drop), none of them
// match isTransientNetworkError today, so a routine dropped/timed-out
// gateway connection crashes the whole openclaw TUI process instead of
// degrading gracefully. Not fixable via config: isTransientNetworkError's
// allow-lists are compiled-in constants, not a runtime setting; there is no
// config surface to widen this classification from outside the package.
//
// Bug, part 2 (secondary fix — applied only if the exact expected text is
// found; SKIPPED with a warning, not a build failure, if not): the TUI's
// client.onGap handler (src/tui/tui.ts, compiled into this package's
// dist/tui-ttOZNpsl.js) fires when the gateway client detects a skipped
// event sequence number. Today it only posts a status line and refreshes
// plugin approvals — it does not re-arm the streaming watchdog. The
// sibling client.onConnected handler, which fires on a full reconnect, DOES
// call reconnectStreamingWatchdog() when recovering from a drop
// (`if (reconnected) reconnectStreamingWatchdog();`). reconnectStreamingWatchdog
// is a free variable already in the exact same lexical scope as both
// handlers (both are assigned as sequential statements inside the same
// enclosing function, one tab of indentation, confirmed against the
// v2026.7.1-2 compiled output on 2026-08-17), and it already no-ops safely
// when there is no active chat run. So a sequence gap alone — not only a
// full reconnect — can leave a streaming response frozen with a stale
// partial render, with no re-arm until either the next full reconnect or
// the watchdog's own timeout. This part is additive and low-risk given the
// confirmed shared scope, but it is a narrower/less-audited change than
// part 1, so it is applied independently and never blocks part 1.
//
// ALREADY FIXED UPSTREAM: not confirmed. No upstream openclaw issue/PR
// found addressing either gap as of 2026-08-17 (checked against
// github.com/openclaw/openclaw main). This is an interim, fleet-local
// mitigation, not a tracked upstream regression.
//
// REMOVAL PLAN: delete this script and its Dockerfile.runtime call site the
// moment OPENCLAW_VERSION bumps to a release where isTransientNetworkError
// natively recognizes gateway-client's own thrown messages (part 1) and
// onGap reconciles the streaming watchdog (part 2). Each part self-detects
// its own "already fixed / shape changed" case (see NO-OP / SKIP logs
// below) so a version bump won't silently reintroduce a no-op or silently
// skip a fix that should still apply — but this step should still be
// deleted for real once confirmed, per this repo's own "no dead compat
// shims" convention (see Dockerfile.runtime's "Version history / why").
//
// Patches COMPILED output inside the GLOBAL npm install
// ($(npm root -g)/openclaw/dist/**), not vendor/openclaw/src (a read-only
// reference copy the Dockerfile never consumes — see vendor/openclaw's
// .gitmodules comment). Fails the build loudly on any part-1 mismatch
// rather than silently shipping unpatched (part 2 mismatches only warn —
// see rationale above). This bug class (a fix that appears to apply but
// silently does nothing) is exactly what CLAW-083's own patch script
// (scripts/patch-openclaw-cache-state.mjs) already guards against; this
// script follows the same pattern.
//
// NOTE ON LOCAL TESTING: this script always resolves its target via
// `npm root -g`, matching the real Dockerfile.runtime build exactly — it
// takes no directory argument and never targets a local project's
// node_modules. To test against a non-global install, override where
// `npm root -g` resolves for the one invocation via the npm_config_prefix
// environment variable (e.g.
// `npm_config_prefix=/path/to/fake-global node this-script.mjs`, with
// /path/to/fake-global/lib/node_modules/openclaw present or symlinked) —
// do not add a CLI-argument override to this script itself, since that
// would diverge it from the precedent's production invocation shape.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const globalRoot = execSync("npm root -g").toString().trim();
const distDir = `${globalRoot}/openclaw/dist`;

// ---------------------------------------------------------------------
// Part 1 (required): widen isTransientNetworkError's message-snippet list
// to cover the gateway client's own thrown error messages.
// ---------------------------------------------------------------------

let part1Candidates;
try {
  part1Candidates = execSync(
    `grep -rl "const TRANSIENT_NETWORK_MESSAGE_SNIPPETS = \\[" "${distDir}"`,
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
} catch (err) {
  if (err.status === 1 && !err.stdout?.toString().trim()) {
    part1Candidates = [];
  } else {
    throw err;
  }
}

if (part1Candidates.length === 0) {
  console.error(
    "[patch-openclaw-network-resilience] part 1: no compiled file defines " +
      "TRANSIENT_NETWORK_MESSAGE_SNIPPETS — isTransientNetworkError's implementation " +
      "has likely moved or been renamed in this OPENCLAW_VERSION. Refusing to guess " +
      "which file to patch — failing the build. Re-derive this patch against the new " +
      "compiled output.",
  );
  process.exit(1);
}

if (part1Candidates.length > 1) {
  console.error(
    `[patch-openclaw-network-resilience] part 1: expected exactly one compiled file ` +
      `defining TRANSIENT_NETWORK_MESSAGE_SNIPPETS, found ${part1Candidates.length}: ` +
      `${part1Candidates.join(", ")}. Refusing to guess which one to patch — failing ` +
      "the build.",
  );
  process.exit(1);
}

const [part1File] = part1Candidates;
const part1Before = readFileSync(part1File, "utf8");

const PART1_OLD = `const TRANSIENT_NETWORK_MESSAGE_SNIPPETS = [
	"getaddrinfo",
	"socket hang up",
	"client network socket disconnected before secure tls connection was established",
	"network error",
	"network is unreachable",
	"temporary failure in name resolution",
	"upstream connect error",
	"disconnect/reset before headers",
	"tlsv1 alert",
	"ssl routines",
	"packet length too long",
	"write eproto"
];`;

const PART1_NEW = `const TRANSIENT_NETWORK_MESSAGE_SNIPPETS = [
	"getaddrinfo",
	"socket hang up",
	"client network socket disconnected before secure tls connection was established",
	"network error",
	"network is unreachable",
	"temporary failure in name resolution",
	"upstream connect error",
	"disconnect/reset before headers",
	"tlsv1 alert",
	"ssl routines",
	"packet length too long",
	"write eproto",
	"gateway not connected",
	"gateway request timeout for ",
	"gateway closed ("
];`;

if (!part1Before.includes(PART1_OLD)) {
  console.error(
    `[patch-openclaw-network-resilience] part 1: ${part1File} does not contain the ` +
      "exact expected TRANSIENT_NETWORK_MESSAGE_SNIPPETS array. OPENCLAW_VERSION likely " +
      "changed and this patch text is stale relative to it. Refusing to guess or " +
      "partially apply — failing the build. Re-derive the patch against the new " +
      "compiled output.",
  );
  process.exit(1);
}

writeFileSync(part1File, part1Before.replace(PART1_OLD, PART1_NEW));
console.log(
  `[patch-openclaw-network-resilience] part 1: patched ${part1File} — ` +
    "isTransientNetworkError now also treats \"gateway not connected\", " +
    "\"gateway request timeout for \", and \"gateway closed (\" as transient, so an " +
    "unhandled rejection carrying one of the gateway client's own network-drop errors " +
    "no longer crashes the process via process.exit(1).",
);

// ---------------------------------------------------------------------
// Part 2 (best-effort): make the TUI's onGap handler also re-arm the
// streaming watchdog, so a sequence gap alone (not only a full reconnect)
// can un-freeze a stale partial response. Additive; skipped with a warning
// (not a build failure) if the expected shape isn't found, since this is a
// narrower, less-audited change than part 1.
// ---------------------------------------------------------------------

let part2Candidates;
try {
  part2Candidates = execSync(
    `grep -rl "client.onGap = (info) => {" "${distDir}"`,
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
} catch (err) {
  if (err.status === 1 && !err.stdout?.toString().trim()) {
    part2Candidates = [];
  } else {
    throw err;
  }
}

if (part2Candidates.length === 0) {
  console.warn(
    "[patch-openclaw-network-resilience] part 2: no compiled file defines " +
      "`client.onGap = (info) => {` — the TUI's onGap wiring has likely moved or been " +
      "renamed in this OPENCLAW_VERSION. Skipping part 2 (non-fatal); part 1 above still " +
      "applied. Re-derive this part of the patch against the new compiled output if the " +
      "onGap freeze behavior still needs fixing.",
  );
} else if (part2Candidates.length > 1) {
  console.warn(
    `[patch-openclaw-network-resilience] part 2: expected exactly one compiled file ` +
      `defining the onGap handler, found ${part2Candidates.length}: ` +
      `${part2Candidates.join(", ")}. Skipping part 2 (non-fatal) rather than guessing ` +
      "which one to patch; part 1 above still applied.",
  );
} else {
  const [part2File] = part2Candidates;
  const part2Before = readFileSync(part2File, "utf8");

  const PART2_OLD = `	client.onGap = (info) => {
		setConnectionStatus(\`event gap: expected \${info.expected}, got \${info.received}\`, 5e3);
		(async () => {
			try {
				await pluginApprovals?.refresh();
			} catch (err) {
				chatLog.addSystem(\`plugin approval refresh failed: \${String(err)}\`);
			}
		})();
		tui.requestRender();
	};`;

  const PART2_NEW = `	client.onGap = (info) => {
		setConnectionStatus(\`event gap: expected \${info.expected}, got \${info.received}\`, 5e3);
		reconnectStreamingWatchdog();
		(async () => {
			try {
				await pluginApprovals?.refresh();
			} catch (err) {
				chatLog.addSystem(\`plugin approval refresh failed: \${String(err)}\`);
			}
		})();
		tui.requestRender();
	};`;

  if (!part2Before.includes(PART2_OLD)) {
    console.warn(
      `[patch-openclaw-network-resilience] part 2: ${part2File} does not contain the ` +
        "exact expected onGap handler body. OPENCLAW_VERSION likely changed and this " +
        "patch text is stale relative to it. Skipping part 2 (non-fatal) rather than " +
        "guessing or partially applying; part 1 above still applied.",
    );
  } else if (!part2Before.includes("reconnectStreamingWatchdog")) {
    console.warn(
      `[patch-openclaw-network-resilience] part 2: ${part2File} contains the expected ` +
        "onGap handler body, but no `reconnectStreamingWatchdog` identifier exists " +
        "anywhere else in the file — it would no longer be an in-scope free variable at " +
        "the onGap call site. Skipping part 2 (non-fatal) rather than inserting a call " +
        "to an undefined function; part 1 above still applied.",
    );
  } else {
    writeFileSync(part2File, part2Before.replace(PART2_OLD, PART2_NEW));
    console.log(
      `[patch-openclaw-network-resilience] part 2: patched ${part2File} — the TUI's ` +
        "onGap handler now also calls reconnectStreamingWatchdog(), so a sequence-gap " +
        "notification alone (not only a full reconnect) re-arms the streaming watchdog " +
        "for any active chat run.",
    );
  }
}

// Part 1 already exits non-zero directly on any failure above; part 2 never
// fails the build (see rationale in the header comment). Reaching here means
// part 1 succeeded and part 2 either succeeded or was skipped with a warning.
process.exit(0);
