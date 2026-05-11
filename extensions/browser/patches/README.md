# extensions/browser/patches/

Local patches applied on top of the vendored upstream `browser` plugin tree.
This directory is the canonical record of every oasis-claw modification to
the upstream code — every change must be a numbered patch here, applied to
`extensions/browser/src/` so the working tree is buildable as-is.

## How the patches flow

1. We `cp -R` upstream `extensions/browser/` into our tree (CLAW-014).
2. Local patches in this dir get applied on top with `git apply`.
3. The working tree at `extensions/browser/src/` is the post-patch state
   — Dockerfile copies that tree into the image directly.
4. `scripts/refresh-browser-plugin.sh` (CLAW-016) replays this directory
   against any new upstream HEAD on every refresh. If a patch fails to
   apply, the refresh opens an issue instead of a PR.

That's the load-bearing property: there is no upstream code in our image
that didn't go through this dir's replay-and-audit gate.

## Numbering

Patches are ordered `NNNN-short-name.patch`. Numbers never reuse — even if
a patch becomes obsolete (upstream merged the fix), the file stays for
historical replay and is marked obsolete in its header rather than
deleted. The script applies them in `sort -V` order.

## Planned patches (CLAW-015)

The CLAW-014 evaluate-slice audit identified one mitigated finding:
`DEFAULT_BROWSER_EVALUATE_ENABLED = true` upstream. We override it at
the entrypoint layer (`browser.evaluateEnabled = false` in
`openclaw.json`), which closes the default-on hole.

The follow-up — CLAW-015 — adds three patches so that when a session
DOES opt in to `evaluate`, every call leaves an auditable trail.
Patches are designed but NOT yet implemented (this directory is the
scaffolding):

### `0001-require-evaluate-audit-log.patch`
- **Hook**: `src/browser/pw-tools-core.interactions.ts` around line 1385
  (the `if (!evaluateEnabled) throw …` gate for `act:evaluate`).
- **Change**: Before letting the `evaluate` call proceed, attempt to
  open an append-only JSONL writer at
  `/home/node/.openclaw/browser-audit/<session-id>.jsonl`. If the open
  fails (permissions, disk full, dir missing), throw
  `"browser.evaluate: audit log unavailable"` — fail-closed.
- **Row format**: ISO timestamp, session id, agent identity (from
  openclaw plugin context), page URL + title, script source verbatim
  (NOT hashed — readability matters for audit), arg shape,
  return-value preview (32KB cap + sha256 of full), DOM-mutation
  summary, network requests issued during the call.
- **Test**: regression test in
  `src/browser/pw-tools-core.interactions.evaluate.abort.test.ts`
  (existing file; we add a new test case) that deletes the audit log
  dir mid-test and asserts the next `evaluate` throws the audit-log
  error.

### `0002-default-tracing-on.patch`
- **Hook**: `src/browser/server-context.lifecycle.ts` (session open) +
  `src/browser/server-context.reset.ts` (session close). Possibly
  also `src/browser/runtime-lifecycle.ts`.
- **Change**: For any session where `evaluateEnabled === true`,
  auto-call `traceStartViaPlaywright({ screenshots: true, snapshots:
  true, sources: true })` at session open and `traceStopViaPlaywright`
  at close, saving to
  `/home/node/.openclaw/browser-audit/<session-id>.trace.zip`. Sessions
  where evaluate is disabled (our default) skip this — no point
  burning disk for sessions that can't run JS anyway.
- **Test**: new `src/browser/server-context.evaluate-tracing.test.ts`
  that opens a session with `evaluateEnabled: true`, performs an
  `evaluate`, closes the session, asserts the trace zip exists and is
  non-empty.

### `0003-evaluate-history-security-collector.patch`
- **Hook**: `plugin-registration.ts:64` (the
  `browserSecurityAuditCollectors` array).
- **Change**: Push a new collector that reads
  `/home/node/.openclaw/browser-audit/*.jsonl` for the requested
  session id (passed in the audit context) and returns the rows as
  structured evidence. Lets `openclaw audit <session>` surface the
  evaluate history alongside other plugin audit data without a
  separate UI.
- **Test**: extend `index.test.ts` (browser plugin's existing test
  for `securityAuditCollectors`) with a fixture that writes a known
  JSONL row and asserts the collector returns it.

### Documentation patch (probably 0004)
- Add a paragraph to the plugin's `skills/browser-automation/SKILL.md`
  explaining that `evaluate` requires opt-in and leaves a JSONL +
  Playwright trace audit trail. Document the
  `npx playwright show-trace <session>.trace.zip` one-liner for
  offline replay. This is the user-facing surface of CLAW-015.

## Manifest

Currently-applied patches (kept in sync with
`extensions/browser/UPSTREAM`'s `applied_patches` list):

(none — CLAW-015 not yet implemented)

## Adding a new patch

```sh
# Make your changes inside extensions/browser/src/...
# Then generate the patch:
cd extensions/browser
git diff -- src/ \
  > patches/000N-short-name.patch
# Edit patches/000N-short-name.patch and add a header explaining the
# WHY, the audit verdict it closes, and the regression test path.
```

Then update `extensions/browser/UPSTREAM`'s `applied_patches:` list and
this README's manifest. The refresh script will replay the new patch
on every future upstream bump.

## Removing a patch

Don't delete. Mark obsolete by appending
`# OBSOLETE: <upstream-PR-or-SHA> merged this <date>` to the patch's
header, and add an empty body (`-` no hunks `-`). The refresh script
skips empty patches but keeps the historical record.
