# Audit Log

This is the immutable per-plugin audit record for everything that ships in
`oasis-claw-runtime`. The principle: **nothing reaches the deployed image
without a recorded verdict.** Append-only — every change is a new row, never a
rewrite, so a future reader can see what we knew and when we knew it.

The audit pipeline is `extensions/clawhub-skill-audit/` running in
`--inspect` mode. Each audit produces a structured JSON verdict at
`vendor/sandbox-skill-audit/_meta/<id>.audit-verdict.json` with `verdict`
(pass / warn / block), `risk_score`, `findings[]`, `coverage.pct_visible`,
and the full `inspections[]` trail. Server-side rule (enforced in
[auditor.ts](extensions/clawhub-skill-audit/src/auditor.ts)): any
high-severity unaudited path or medium+ auditability finding caps the
verdict at `warn` and blocks `pass`.

All audits use **Opus 4.7** (`claude-opus-4-7`) as the auditor. Cost is in
the cents-per-audit range; we do not skimp on the audit model.

---

## First-party plugins (we wrote these)

These nine plugins are oasis-claw's own code. They aren't fed to the Opus
auditor as "skill audits" — they're audited via code review, unit tests,
and the cross-cutting `adversarial.test.ts` suite under
`extensions/prompt-injection-reporting/`. They're listed here for
completeness so the log captures the full deployed surface.

| Plugin | Source | Coverage | Notes |
|---|---|---|---|
| `prompt-injection-reporting` | first-party | 22 adversarial tests | Tamper-evident JSONL + Telegram alert |
| `secrets-vault` | first-party | unit + redaction-hook tests | AES-256-GCM at rest, no plaintext in transcript |
| `approval-gate` | first-party | unit tests | `forward_captcha` + library code for API approval |
| `session-history` | first-party | sandbox-isolation invariants | Append-only JSONL; logDir-escape tests pass |
| `dot-swarm` | first-party | unit tests | Non-exclusive memory supplement |
| `agent-primitives` | first-party | unit tests | sleep / dream / compact, FS side wired |
| `clawhub-skill-audit` | first-party | 23 unit tests | The auditor itself; commit `02538e1` |
| `model-switcher` | first-party | unit tests | `setmodel` + `/setmodel`; CLAW-006 fix landed |
| `oasis-voice` | first-party | 11 unit tests | Speech + realtime-STT provider; CLAW-003 |

---

## Vendored upstream plugins (we copied these in)

Plugins copied from upstream openclaw. Each has an
`extensions/<id>/UPSTREAM` file recording the source SHA, dependency
versions, and any binary blob revisions. Each is audited before merge,
re-audited on every refresh.

### `extensions/browser/` — vendored 2026-05-08

Source: `vendor/openclaw-source@e3b919fd0759a7c3399ff8841b46dbfb4fd2bbde` ·
`playwright-core@1.59.1` · Chromium revision `1217` (Chrome for Testing
147.0.7727.15). Pin file: [extensions/browser/UPSTREAM](extensions/browser/UPSTREAM).

The browser plugin is our largest single audit surface — ~39k LOC of TS
plus a Chromium binary. We ran four targeted audit slices to drive
coverage above the 55% the broad pass produced alone, focusing on the
security-sensitive surfaces specifically:

| Slice | Date | Verdict | Risk | Findings | pct_visible | Files inspected | Verdict file |
|---|---|---|---|---|---|---|---|
| broad | 2026-05-08 | **pass** | 19 | 0 | 55% | 3 | [browser.audit-verdict.json](vendor/sandbox-skill-audit/_meta/browser.audit-verdict.json) |
| auth | 2026-05-09 | **pass** | 11 | 0 | 80% | 6 | [browser-auth.audit-verdict.json](vendor/sandbox-skill-audit/_meta/browser-auth.audit-verdict.json) |
| ssrf | 2026-05-09 | **pass** | 19 | 0 | 55% | 4 | [browser-ssrf.audit-verdict.json](vendor/sandbox-skill-audit/_meta/browser-ssrf.audit-verdict.json) |
| evaluate | 2026-05-09 | **warn** | 39 | 1 medium | 55% | 5 | [browser-evaluate.audit-verdict.json](vendor/sandbox-skill-audit/_meta/browser-evaluate.audit-verdict.json) |
| ai-loop | 2026-05-09 | **pass** | 17 | 0 | 70% | 4 | [browser-ai-loop.audit-verdict.json](vendor/sandbox-skill-audit/_meta/browser-ai-loop.audit-verdict.json) |

**Files deep-walked across all slices** (17 distinct):
`index.ts`, `plugin-registration.ts`, `browser-config.ts`,
`src/browser/control-auth.ts`, `src/browser/bridge-server.ts`,
`src/browser/csrf.ts`, `src/browser/bridge-auth-registry.ts`,
`src/browser/server-middleware.ts`, `src/browser/http-auth.ts`,
`src/browser/request-policy.ts`, `src/browser/navigation-guard.ts`,
`src/browser/cdp-reachability-policy.ts`,
`src/browser/ssrf-policy-helpers.ts`, `src/browser/constants.ts`,
`src/browser/config.ts`, `src/browser/pw-tools-core.interactions.ts`
(truncated at 32KB on first pass; per-file budget bumped to 96KB
2026-05-09 in [scripts/audit-sandbox.ts](scripts/audit-sandbox.ts)),
`src/browser/pw-ai.ts`, `src/browser/pw-ai-module.ts`,
`src/browser/act-policy.ts`, `src/browser/client-actions-core.ts`.

**One real finding, mitigated.** The evaluate-slice audit (2026-05-09)
verified in source that `DEFAULT_BROWSER_EVALUATE_ENABLED = true` upstream
([extensions/browser/src/browser/constants.ts](extensions/browser/src/browser/constants.ts)).
The runtime gate is live at
[pw-tools-core.interactions.ts:1367,1385](extensions/browser/src/browser/pw-tools-core.interactions.ts) —
both `act:evaluate` and `wait --fn` throw with
`browser.evaluateEnabled=false` when the toggle is off — but the upstream
default of *on* meant any agent session could run arbitrary JS in pages
without an opt-in.

**Mitigation in force:** [scripts/runtime-entrypoint.sh](scripts/runtime-entrypoint.sh)
writes `browser.evaluateEnabled = false` to the top-level `browser` block of
`openclaw.json` on every boot. The line is commented as load-bearing; removing
it requires CLAW-015's per-session opt-in + JSONL audit log + Playwright
trace patches first. Banner reflects the override:

```
   browser eval   : disabled (per CLAW-014 audit; per-session opt-in only)
```

**Other audit findings of note (all clean):**
- Auth surface: bridge-server defaults to loopback bind, control-auth
  middleware applies app-wide before any route handler (fail-closed),
  constant-time compare via `safeEqualSecret`, CSRF protected on
  state-changing routes.
- SSRF surface: request-policy denies loopback / RFC1918 / link-local /
  metadata IPs (169.254.169.254) by default; navigation-guard re-checks
  on redirects; defense-in-depth between request-policy and
  cdp-reachability-policy.
- AI-loop: there is no autonomous AI-loop in the threat-model sense.
  `pw-ai.ts` is a re-export barrel (despite the name); `act-policy.ts`
  is timeout bounds, not a decision policy; no indirect reach into
  `evaluate` from non-`evaluate` actions.

**Refresh policy:** [extensions/browser/UPSTREAM](extensions/browser/UPSTREAM)
documents the bump runbook for each layer (Chromium-only, Playwright-only,
openclaw-only, kill-switch). The CLAW-016 weekly job re-runs this audit set
against any upstream bump and opens a PR on success / an issue on
conflict. Until that PR merges, the deployed `extensions/browser/` stays
at `e3b919fd`.

---

## Skill-snapshot audits (third-party clawhub skills we considered)

Static audits performed against quarantined skill snapshots in
`vendor/sandbox-skill-audit/`. These ran during the CLAW-005 audit-pipeline
work and informed the CLAW-003 / CLAW-004 voice-call integration plans.

| Skill | Date | Verdict | Risk | Verdict file | Disposition |
|---|---|---|---|---|---|
| `voice-call` | 2026-05-06 | **pass** | 14 | [voice-call.audit-verdict.json](vendor/sandbox-skill-audit/_meta/voice-call.audit-verdict.json) | Use upstream Twilio provider unchanged; we register `oasis-voice` as a SpeechProvider one layer in (CLAW-003) |
| `sherpa-onnx-tts` | 2026-05-06 | warn | — | [sherpa-onnx-tts.audit-verdict.json](vendor/sandbox-skill-audit/_meta/sherpa-onnx-tts.audit-verdict.json) | sha256-pin requirement informed our `oasis-voice/scripts/download_weights.py` design |
| `clawphone-phone` | 2026-05-06 | — | — | [clawphone-phone.audit-verdict.json](vendor/sandbox-skill-audit/_meta/clawphone-phone.audit-verdict.json) | Reviewed; not adopted |

---

## How to reproduce any audit row

Every audit row above can be reproduced from the snapshot files in
`vendor/sandbox-skill-audit/`. The dry-run is free (no API spend) and writes
the prompt input deterministically:

```sh
node scripts/audit-sandbox.mjs --only=browser-auth         # dry-run, free
ANTHROPIC_API_KEY=… node scripts/audit-sandbox.mjs \
    --only=browser-auth --live --inspect                   # live audit
```

Replace `--only=<id>` with the slice you want. The `--inspect` flag enables
the multi-turn deep-walk via `inspect_file` against
`vendor/openclaw-source/extensions/`. Verdict is written to
`vendor/sandbox-skill-audit/_meta/<id>.audit-verdict.json`.

---

## Change log

| Date | Change |
|---|---|
| 2026-05-11 | CLAW-014 image-build smoke verified. `docker build -f Dockerfile.runtime` succeeds end-to-end; image at 2.53GB (~1.9GB of that is Chromium + headless-shell + apt deps). The `test -d /opt/playwright/chromium-1217` Dockerfile assertion passes; inside the image, `/opt/playwright/chromium-1217/chrome-linux/chrome --version` reports `Chromium 147.0.7727.0`. Note: playwright-core@1.59.1's browsers.json declares `147.0.7727.15` for revision 1217 — the .15 vs .0 patch-level drift is a known Playwright-side mismatch; the REVISION (1217) is what's enforced, browser_version is informational. UPSTREAM file updated with a clarifying note. |
| 2026-05-11 | CLAW-016 refresh script (`scripts/refresh-browser-plugin.sh`) dry-run validated. Two bugs found and fixed in-loop: (1) `grep` pattern had unbalanced parens, crashed mid-keyword-scan; rewritten as ERE with literal `\(` escapes. (2) `rsync --delete` wiped our own UPSTREAM file + patches/ dir because they don't exist upstream; fixed by copying both into the scratch tree before the final sync. Also gated working-tree staging behind `--live` so no-flag dry-runs are read-only. Final dry-run against upstream HEAD `1fcb6e64` (vs. our pinned `e3b919fd`): rc=0, 8009-line upstream diff, 206 security-keyword hits (mostly normal HTTP/ws references in SSRF test fixtures), no working tree changes. |
| 2026-05-11 | CLAW-017 GH-side configuration applied. Branch protection set on `main` via `gh api`: requires all three `test.yml` jobs (`pnpm test (all extensions)` / `plugin registration smoke` / `tsc --noEmit (per-extension)`) to pass, 1 approving review, linear history, no force pushes / deletions, dismiss stale reviews on new push, required conversation resolution. `enforce_admins: false` (admin override available for true emergencies). |
| 2026-05-11 | REPO CI's `ANTHROPIC_API_KEY` GH-Actions secret set on `oasis-main/oasis-claw`. **Currently Mike's personal Anthropic key**, lent at no charge to the repo until oasis-x stands up scoped Bedrock credentials — see CLAW-018. Scope note: personal oasis-claw instances (Nimbus etc.) keep using their own personal keys indefinitely; only the repo-level CI secret needs to swap. Expected billing exposure on the temp loan: ~$15/yr on weekly refresh autopilot, ~$0.30 per manual `workflow_dispatch`. |
| 2026-05-11 | CLAW-021 inbound voice landed on `dev` as `d800292`. CI green (3/3 status checks). Adds `MediaUnderstandingProvider` registration to `extensions/oasis-voice/` for inbound Telegram voice messages (the third provider type alongside SpeechProvider + RealtimeTranscriptionProvider). Co-requires sister-repo commit `oasis-voice@436a64f` (extends `/v1/stt/transcribe` to accept any-format audio via ffmpeg). Docker-compose now runs `oasis-voice:cpu` as a sibling container on the `oasis_runtime` bridge network — no host port exposure, no auth boundary between containers (sidecar trusts the network). Entrypoint defaults `OASIS_VOICE_ENDPOINT` to `http://oasis-voice:8731` (docker DNS), pins `tools.media.audio.provider = "oasis-voice"` and `models.providers.oasis-voice.baseUrl` so inbound voice notes route to the local lite tier rather than any cloud STT provider that may register later. Plugin: 21/21 vitest pass (was 11). oasis-voice CPU image built locally at 6.37GB — flagged as follow-up in sister repo (target ~500MB; pyproject `[cpu]` extras pulling in torch + nvidia CUDA libs unnecessarily). |
| 2026-05-11 | First push of CLAW-014/016/017 to `dev` landed as commit `b5dd07e`. CI caught two layers of real issues on consecutive runs; both fixed in-loop. **Round 1** (commit `f195959`): `pnpm install --frozen-lockfile` failed because vendored `extensions/browser/package.json` declares `@openclaw/plugin-sdk: workspace:*` (upstream-monorepo-only ref); fixed by excluding `extensions/browser` from our pnpm workspace via `!` glob. Also: `extensions/model-switcher/package.json` had a left-over `workspace:*` to `openclaw`; replaced with `^2026.4.26`. Also: smoke step couldn't find `tsx`; added as a root devDep. Also: typecheck would have hit the same plugin-sdk import error against the browser tree; added an explicit skip with the rationale (audit cohort is the real correctness gate for vendored plugins). **Round 2** (commit `2c7fcdb`): smoke failed with `Cannot find package 'zod'` for 4 extensions whose `index.ts` imports zod but whose `package.json` didn't declare it (works in production because the Dockerfile does `npm install zod` at /app, but pnpm's strict per-package isolation in CI exposes the missing declarations). Added `"dependencies": { "zod": "^4.4.1" }` to secrets-vault / session-history / clawhub-skill-audit / prompt-injection-reporting. **Result**: CI fully green on `2c7fcdb` — all three required status checks (`pnpm test (all extensions)` / `plugin registration smoke` / `tsc --noEmit (per-extension)`) pass. Branch protection on `main` now has a clean recent run to gate against. |
| 2026-05-10 | CLAW-017 CI workflows landed: `test.yml` (merge-blocking) + `image-build.yml` (informational) + `refresh-browser.yml` (weekly + manual). CLAW-016 refresh script (`scripts/refresh-browser-plugin.sh`) is the core of the refresh workflow. Live audits run on refresh only — every other PR trusts the pre-PR audit cohort. |
| 2026-05-09 | Browser audit cohort complete: broad / auth / ssrf / evaluate / ai-loop. One finding (`DEFAULT_BROWSER_EVALUATE_ENABLED=true` upstream) mitigated at entrypoint. Per-file inspector budget bumped 32KB→96KB. Image grew Chromium install layer (~400MB). |
| 2026-05-08 | Browser plugin vendored from upstream openclaw at SHA `e3b919fd`. UPSTREAM file pins playwright-core@1.59.1 + chromium@1217. CLAW-014/015/016 written to `.swarm/queue.md`. |
| 2026-05-07 | CLAW-003 oasis-voice plugin landed (11 tests). |
| 2026-05-07 | CLAW-001/002 lite-tier voice backends landed (Piper + Moonshine; 30 tests). |
| 2026-05-06 | CLAW-005 audit-pipeline deep-walk landed (commit `02538e1`, 23 tests). Initial skill-snapshot audits run against `voice-call`, `sherpa-onnx-tts`, `clawphone-phone`. |
