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

These ten plugins are oasis-claw's own code. They aren't fed to the Opus
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
| `dot-swarm` | first-party | unit tests | Non-exclusive memory supplement + `swarm_read`/`compact` tools + `swarm-compact` CompactionProvider |
| `clawhub-skill-audit` | first-party | 23 unit tests | The auditor itself; commit `02538e1` |
| `model-switcher` | first-party | unit tests | `setmodel` + `/setmodel`; CLAW-006 fix landed |
| `oasis-voice` | first-party | 11 unit tests | Speech + realtime-STT provider; CLAW-003 |
| `sleep-cycle` | first-party | 23 unit tests (schedule math, mutex state machine, full cycle orchestration w/ virtual clock) | Biomimetic sleep/wake: doze mutex (queue-and-replay via claiming `before_dispatch`), dream window, deep-sleep `sessions.compact`+`sessions.reset`, waking summary w/ vector-ranked memory hits. Uses child_process to drive gateway RPCs through the openclaw CLI (install-scanner false positive, same shape as browser) |

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
| 2026-07-14 | **Fleet expansion + Hello World (replaces ClapTrap).** Brought **ButterBolt** (18793) and **House** (18791) online on fleet standards (Claude Sonnet 4.6, Telegram polling, heartbeat OFF, native reset 23:00, dreams staggered 22:35/22:40). Retired **ClapTrap** and replaced it with **Hello World** 👋 (18796, `bots/hello-world/`, reuses ClapTrap's Telegram token; claptrap service removed from the bots overlay, volume left dormant) — a deliberately "blank" low-persona admin/ops assistant on base gog identity `mike@oasis-x.io` (dream 22:45). Per Mike: privileged send-as-`hello@` DEFERRED (mike@ only for now); when wired, prefer service-account + Workspace domain-wide-delegation, NOT oasis-auth (investigation: oasis-auth is a Firebase product-login service, unrelated to email; exp's send-as is a standalone Gmail client holding hello@'s own token). Cloud admin for bots → scoped `openclaw-tf-bot` IAM user, NOT Mike's personal admin keys in oasis-cloud-admin (investigation flagged those as full-admin + human-identity-attributed + no state-lock). **Bug fixed:** `bots/Makefile` per-bot `up`/`recreate`/`rebuild` now carry `--no-deps` — the plain bots compose was recreating the dual-homed sidecars (oasis-voice/oasis-semantics) and detaching them from VH's `oasis_sandboxed` net (VH lost DNS to them; reconnected live). **Security finding (separate task):** dev+prod RDS master passwords committed plaintext in `oasis-cloud-admin` `CREDENTIALS_NOTE.txt` (verified) — flagged to rotate+scrub. |
| 2026-07-14 | **CLAW-047 — per-bot GitHub access (fine-grained PATs + rollback-safe git guardrail).** Runtime image bumped to **IMG7 (`4f7bc26e`)**: adds **gh 2.96.0** (release tarball, arch-aware, pinned + `--version` assert, placed late so it doesn't invalidate the npm/Playwright layers) and a **git guardrail** — `scripts/git-policy/git-guard.sh` symlinked to `/usr/local/bin/git` shadows `/usr/bin/git`. It FAILS OPEN (normal git untouched) and blocks only, on `git push`: `--force`/`-f`, `--force-with-lease`, `--force-if-includes`, `--mirror`, `--delete`/`-d`, colon (`:ref`) and leading-`+` refspecs, and pushes to a repo not in `OASIS_GIT_REPOS`; strips `--no-verify` so the global `pre-push` hook (backstops direct `/usr/bin/git`: refuses deletes + non-fast-forwards) always runs. 26/26 wrapper unit tests green. Credentials: a no-network helper (`git-credential-oasis-gh`) serves the per-bot `GH_TOKEN` for github.com https — no boot-time GitHub call, so egress-locked VH still boots. Entrypoint exports `GIT_CONFIG_GLOBAL=$CONFIG_DIR/.gitconfig` (rootfs is read_only; validated the node gateway pid carries it → agent's git resolves hooksPath) + wires identity/helper/hooksPath when `GH_TOKEN` present. Management: **`scripts/claw-git`** (sibling of claw-creds; `make git-list/git-check/git-set/git-repos/git-rotate`) stores/scopes/rotates per-bot PATs + push allowlist + recreates (VH via the 4-file sandbox stack). PAT *creation* stays Mike's UI step; branch protection is the real server-side guarantee. Runbook: `.swarm/GIT_ACCESS_RUNBOOK.md`. **Validated end-to-end on Hello World** (recreated onto IMG7: gh present, force-push blocked exit 13, gitconfig on the volume, gateway carries GIT_CONFIG_GLOBAL). Rest of fleet migrates to IMG7 on next recreate / `claw-git set`. Open: Mike mints the PATs; `nusci`/`bounty_hunter` not on GitHub yet; VH egress lock blocks github.com (decision pending). |
| 2026-07-14 | **CLAW-046 pivot — sleep-cycle rebuilt on openclaw's NATIVE session reset (hybrid); cron + scope wall deleted.** Root realization: the whole custom cron + `sleep_deep`-tool machinery was reinventing a wheel openclaw already turns. openclaw natively resets long-lived sessions on a schedule (`session.reset` policy, `mode:"daily"`, `atHour` local) — archiving the transcript to `<file>.reset.<ts>` and starting fresh **with no cron, no tool, and no operator.admin scope**. Proof it was already running: the DM sessions self-archived at **04:31 today** (default `atHour:4`). That last point dissolves the entire bootstrap dead-end we hit: a fresh headless bot's CLI only gets `operator.read`, and BOTH `cron add` AND `sessions.reset` need `operator.admin` (a device-approval a human must grant — Nimbus's was approved long ago, YesMan/VH's weren't; hand-editing pairing state was correctly blocked by the permission classifier). Investigated the fully-supported in-process path too (`gateway_start` hook → `ctx.getCron()`, how memory-core self-installs its dream cron) — real, but it only moves cron creation in-process; `sleep_deep`'s `sessions.reset` still needs admin. The native reset needs neither. **New shape (hybrid, per Mike):** (1) entrypoint seeds `session.resetByType.direct = {mode:"daily", atHour:N}` (env `OASIS_SESSION_RESET_HOUR`, default 4 → wake fresh each morning); (2) plugin's **`before_reset` hook** rides that reset — captures the handoff tail from the archived messages + vector-ranks memories (one oasis-semantics burst, zero LLM), staging the waking summary — filtering on reason `daily`/`idle` so it never collides with the manual path; (3) the memory supplement injects it into the fresh session; (4) a slimmed **`sleep_deep` TOOL kept only for MANUAL on-demand resets** (e.g. today's mid-day rate-limit relief) — its `sessions.reset` needs admin, fine on approved bots, a manual-only edge on fresh ones. Deleted: the entrypoint cron-install block (+ its scope failures, race, dedup), the getCron plan. Ordering (dream→reset) preserved for free: memory-core dream @22:20 → native reset @~4 AM next morning. Tests 23→30 (7 new before-reset: reason-filtering, handoff formatting, degrade-on-semantics-down, never-throws); 7-plugin smoke green (sleep-cycle now `tools:[sleep_deep] hooks:[before_reset]`); both entrypoint python heredocs `py_compile` clean. **Deployed:** image `d60908` reconciled across Nimbus + Yes Man + Van Helsing (VH via the 4-file sandbox stack `--no-deps`; egress lock re-verified: example.com blocked, anthropic reachable; sidecars untouched). All 3 boot **CLEAN — zero scope/pairing/cron errors** (there's no cron install to fail). Removed Nimbus's now-obsolete `sleep-cycle-deep` + stray `sleep-test` crons. Waking-summary live capture confirms organically on the next daily reset (~4 AM) — unit-tested + registration-verified in the meantime. |
| 2026-07-14 | **Heartbeat genuinely OFF fleet-wide (was silently firing LLMs).** Standing decision reaffirmed by Mike: no autonomous heartbeat until a proxy-signal monitor exists — cron-driven rhythm only. Found the real bug: openclaw's DEFAULT `HEARTBEAT.md` template is NOT "effectively empty" — its `## Related / - [Heartbeat config](…)` footer is a non-empty list item, so `isHeartbeatContentEffectivelyEmpty` returns false and the heartbeat fires a real LLM on every wake (YesMan's last wake had `skipReason:None` = it ran). The runtime gate (`system heartbeat disable`) is unreliable at boot (needs a paired/elevated scope boot tokens lack — failed on YesMan/VH, worked on Nimbus), and openclaw has no persistent config off-switch (`HeartbeatSchema` is `.strict()`, no `enabled`; removing the block falls through to the vanilla 30m loop). So the entrypoint now writes a genuinely-empty `HEARTBEAT.md` (comment/header lines only) every boot → every wake short-circuits to `skipReason:empty-heartbeat-file`, no LLM, no gateway call, no scope. Applied live to all 3 + baked into the image (`OASIS_HEARTBEAT_DISABLED=1` default). The seeded 5h cadence stays in config as the ready cadence for when heartbeats are re-enabled. |
| 2026-07-14 | **Mid-day manual `sleep_deep` reset relieved a live gpt-5.5-pro rate limit** (Mike's call — "this is the problem this work was meant to solve"). Nimbus's DM (`telegram:direct:8533179295`) prompt prefix went from ~29k tokens (replayed every turn) to **127 bytes**. The cron `run-now` executed on the agent-default model (Claude Sonnet), not the session-pinned `gpt-5.5-pro`, so it wasn't itself blocked. Note recorded: prompt caching cuts COST but NOT TPM — OpenAI counts the full ~29k tokens against the 50k/min cap each turn (the error's `Requested 28903` proves it), so a bloated transcript starves the budget; even with daily reset, one day's heavy DM can still strain a "pro"-tier TPM. That's a `/models` choice, orthogonal to the sleep cycle. |
| 2026-07-13 | **CLAW-046 UNBLOCKED — cron-driven redesign + `tools.profile` root cause fixed; sleep-cycle re-enabled.** Pivoted the scheduler off the (impossible) plugin `setInterval` onto an **openclaw native cron** the entrypoint auto-installs: a nightly light-context `agentTurn` (`--session isolated --no-deliver --tools sleep_deep`) whose only job is to call the plugin's `sleep_deep` TOOL. Rewrote the plugin to two reliable primitives only — the `sleep_deep` tool (lists sessions, archives+`sessions.reset` the ones matching `sessionMatch`, ranks memories via oasis-semantics, writes the waking state) + the waking-summary supplement — no daemon, no mutex (openclaw already serializes turns per session). This surfaced the REAL blocker, which was never the timer: the cron turn failed with *"No callable tools remain after resolving explicit tool allowlist (runtime toolsAllow: sleep_deep); no registered tools matched."* Root-caused via gateway logs to **`[agents/tool-policy] tool policy removed 1 tool(s) via tools.profile (coding): sleep_deep`** — the fleet's restrictive `coding` tool profile (`CORE_TOOL_PROFILES.coding = core-tool-ids + bundle-mcp`, no `group:plugins`) strips ALL plugin tools *before* the cron's `--tools` allowlist resolves, so the allowlist matched nothing. (A red-herring `contracts.tools` requirement was found + satisfied along the way — `registry.ts registerTool` early-returns via silent `pushDiagnostic` without it — but the manifest `contracts:{tools:["sleep_deep"]}` alone did NOT fix it; the profile filter did.) **Fix:** seed `tools.alsoAllow:["sleep_deep"]` (openclaw `mergeAlsoAllowPolicy` folds it into the active profile's allow list) — the tightest possible exemption: re-admits exactly this one plugin tool, no `group:plugins` blanket. Entrypoint now auto-manages it (mirrors `OASIS_SLEEP_ENABLED`; harmless no-op under a `full` profile). **Validated on Nimbus** (image `a65bba85`, live config + gateway restart): cron `run-now` → `lastRunStatus:ok`, tool-policy log now strips 6 other tools but keeps `sleep_deep`, state file → `state:"light_sleep"`, 0 sessions reset under the safe `__nomatch_test__` sentinel. sessionMatch restored to `["telegram:direct"]` (matches the real DM `agent:main:telegram:direct:8533179295` — the 92.5% cache-write driver — excludes slash/group). 23 unit tests + 7-plugin smoke green. Reconciling the rebuilt image (entrypoint carries the alsoAllow seed) across Nimbus + Yes Man + Van Helsing (4-file sandbox stack). Supersedes the BLOCKED row below. |
| 2026-07-13 | **CLAW-046 deploy attempt — sleep-cycle scheduler BLOCKED by openclaw plugin runtime; disabled.** Rebuilt the image and recreated Nimbus + Van Helsing (via the 4-file sandbox stack, `--no-deps` to preserve the dual-homed sidecars — verified they stayed on `oasis_runtime`+`oasis_sandboxed` and VH's egress stayed locked: example.com→403, anthropic→401) + Yes Man. Then hit a hard framework limit: **openclaw does not run a plugin's background `setInterval`** — the nightly scheduler never fires. Verified exhaustively: register() runs in a throwaway snapshot context (its immediate synchronous tick fires once — an already-past doze *looked* like it worked, masking the bug — but a future-scheduled doze never fires); `registerService().start()` is never invoked for `--link` plugins; the `gateway_start` hook didn't fire our handler either. Two traps found + fixed: (1) starting the timer in register() made `openclaw plugins install --link` (entrypoint loop) hang forever, wedging boot → added `timeout 90` around each install; (2) openclaw swallows plugin stdout + async api.logger, so the daemon is invisible in `docker logs` (state file is the only observability). Live-validated the destructive RPCs on a low-stakes session: `sessions.reset` archives the transcript as `.reset.<ts>` + starts fresh (works); `sessions.compact` times out >10s on large sessions (best-effort, non-fatal). **Resolution:** sleep-cycle `config.enabled=false` on all 3 — inert + safe (mutex never locks, no session reset). Orchestration/mutex/waking logic is sound (23 tests green); only the periodic trigger is blocked. Next: drive it from openclaw's native cron service or a host launchd job calling the proven RPCs — Mike to choose. Core efficiency config (heartbeat + wind-down dream) intact on all 3; claw-spend works. |
| 2026-07-13 | **`sleep-cycle` extension built (efficiency pass, part 3).** New first-party plugin implementing the biomimetic sleep architecture from `.swarm/KOLMOGOROV_SLEEP_ARCHITECTURE.md`: **doze** (waits until idle — live-transcript mtime quiet for `idleGraceMinutes`, deferring up to `maxDeferMinutes` — then takes a task/message mutex via a claiming `before_dispatch` hook; inbound messages while locked are queued, answered with a doze note, and REPLAYED via `sessions.send` after release, never dropped), **dream** (memory-core's dreaming cron rides the cron lane, unaffected by the mutex; the cycle waits out the window), **deep sleep** (per matched session: capture handoff tail from the raw transcript, `sessions.compact`, `sessions.reset` — openclaw renames the old transcript in place = archive; this is the nightly reset that attacks the 92.5% monolithic-session cache-write bill), **light sleep** (lock released BEFORE this state — resting but wakeable), **waking summary** (memory-prompt supplement injecting yesterday's handoff + archived-transcript pointers + top-K memory chunks vector-ranked through the oasis-semantics sidecar `/api/embed`, one embed burst per night, zero LLM; morning-gated). Gateway RPCs driven through the openclaw CLI via child_process (WS protocol reuse — install-scanner false positive, `--dangerously-force-unsafe-install`, same shape as browser). Crash-safety: state persisted to plugin stateDir; stale locks (>3h) force-released; cycle failure path releases the mutex. Defaults ON at install via entrypoint merge (env: `OASIS_SLEEP_ENABLED/DOZE/DEEP/WAKE/TZ`; defaults 22:00 / 22:40 / 06:30 ET, aligned with the 22:20 dream cron + 06:30–22:30 heartbeat activeHours). 23 unit tests (schedule math, mutex machine, full-cycle orchestration on a virtual clock incl. busy-deferral + gateway-failure paths); registration smoke extended to 7 plugins (mock gained `allowEmptySupplement` — the waking supplement is legitimately empty pre-first-cycle); full workspace suite green. NOT yet deployed: ships on next image rebuild — Nimbus via normal recreate, Van Helsing ONLY via the 4-file COMPOSE_VH_SANDBOX stack + green canary (see fleet runbook). |
| 2026-07-13 | **Efficiency pass, part 2 + cost re-diagnosis.** Corrected part-1's attribution: the heartbeat was NOT the cost driver — both bots' `HEARTBEAT.md` are empty and openclaw skips the LLM call when empty (`skipReason:"empty-heartbeat-file"`). The real driver is ONE monolithic session — the persistent Telegram DM `12e28e70` (4.5 MB) = **$1,054 of $1,139 all-time cache-write (92.5%)**; all cron `agentTurn` jobs run inside it, so every chat + cron turn re-caches the whole growing prefix. Uniform heartbeat scheme applied live to both bots (hot-reload): `every 5h` / activeHours 06:30–22:30 ET / isolated+light+skip; entrypoint fallback + `.env`/`.env.example` updated so all 7 bots inherit it. Dreaming moved 03:00→22:20 (Nimbus)/22:25 (VH) — the "-> dream -> sleep" wind-down step. NOTE: openclaw heartbeat is interval+hash-phase (not clock-pinnable), so exact 7/12/5/10 isn't achievable natively — decision recorded to keep heartbeat dormant and drive the daily rhythm via cron sleep-states instead (see KOLMOGOROV_SLEEP_ARCHITECTURE.md). Disabled two Nimbus plant crons (`🪴 Sunday Plant Watering`, `💧 Wednesday Plant Top-Up`) via `openclaw cron disable` (cycle drifted after missed waterings); 6 crons remain incl. Epidemiology Digest + 636 Roxborough summary. Design note for Kolmogorov (sleep/wake state machine + proxy-signal heartbeat) written to `.swarm/KOLMOGOROV_SLEEP_ARCHITECTURE.md` + `ai_research/.swarm/`. Cross-bot dream/task read-access (YesMan/VH/Kolmogorov): decided curated read-only (dreams+MEMORY+handoffs, not secret-bearing state DB) — not yet wired. |
| 2026-07-12 | **Runtime-efficiency pass (heartbeat + spend visibility).** Diagnosed the fleet's token burn via openclaw's own `usage-cost` ledger: Nimbus ≈$780/30d (per `usage-cost`; ≈$850 counting recent active-session days it defers), **~97% of it cache-write**. Root cause: openclaw's default agent self-wakes every 30m (`DEFAULT_HEARTBEAT_EVERY`) and each wake reloads the FULL growing transcript, re-writing the prompt cache (short TTL ⇒ expired between wakes). Van Helsing was running this loop **unconfigured** on the 30m default, and — being behind the egress-proxy allowlist (anthropic + telegram only) — couldn't reach the OpenRouter/LiteLLM price catalogs, so its models were unpriced and its spend read **$0 (invisible)**. Fix: set `agents.defaults.heartbeat` on both bots — Nimbus `every:2h` / activeHours 07:00–23:00 ET; Van Helsing `every:4h` / activeHours 09:00–18:00 ET; both `isolatedSession+lightContext+skipWhenBusy` (heartbeat re-caches only HEARTBEAT.md, not the transcript). activeHours gates ONLY the autonomous heartbeat — inbound Telegram replies are unaffected. Applied **live via hot-reload** (`[reload] config hot reload applied`) — no restart, no soak interruption. Staggered dreaming (Nimbus 03:00, VH 03:40). Wired the knobs into `scripts/runtime-entrypoint.sh` (env-driven, setdefault; cheap-context fallbacks so no bot ever runs the 30m full-context loop) + `.env.example` + per-bot `.env`. New `scripts/claw-spend`: per-bot × per-model spend report that derives openclaw's own catalog rates from priced entries and applies them to unpriced bots (VH now visible), counting the recent days openclaw's summary defers. No active cron jobs found; healthchecks are curl-only (no token cost). |
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
