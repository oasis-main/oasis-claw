# oasis-claw

Vanilla [openclaw](https://github.com/openclaw/openclaw) is a capable AI gateway, but it ships without answers to four production concerns: **what happens when the model is manipulated**, **where credentials go when the user pastes them**, **how you audit what the agent actually did**, and **what stops a malicious skill from the registry running before you ever look at it**. oasis-claw is a thin plugin layer that fills exactly those gaps — no fork, no divergence from upstream, eleven focused extensions on top of the standard plugin SDK. Six are the security/observability surface; five ship capability: voice (`oasis-voice`), LLM routing (`model-switcher`), headless browser (`browser`), local embeddings (`oasis-semantics`), and the biomimetic sleep/wake lifecycle (`sleep-cycle` — doze mutex, nightly session compact+reset, waking summary). Private long-term memory is the bundled upstream `memory-core` plugin, enabled and configured (not forked) with nightly dreaming consolidation on by default. Anything we vendor in from upstream (currently just `browser`) is pinned, audited, and refresh-gated — see [AUDIT_LOG.md](./AUDIT_LOG.md).

## What this adds over vanilla openclaw

| Gap in vanilla openclaw | oasis-claw plugin | What it does |
|---|---|---|
| No agent-side injection reporting | `prompt-injection-reporting` | Agent calls `report_injection` when it detects manipulation; signed JSONL entry + Telegram operator alert |
| Credentials land in plaintext in LLM context | `secrets-vault` | AES-256-GCM at-rest vault; agent gets an opaque handle, not plaintext; redaction hook strips secrets before any JSONL write |
| Sensitive actions execute without human sign-off | `approval-gate` | `forward_captcha` tool routes CAPTCHA images through Telegram and returns the operator's typed solution; API approval policy hooks for HTTP requests |
| No immutable session transcript | `session-history` | Append-only JSONL at `llm_input`, `llm_output`, and `tool_call` events; sandbox invariant tests verify the writer never escapes its `logDir` |
| Agent loses all context on session reset | `dot-swarm` | Shared `.swarm/` stigmergy: injects `state.md` + `queue.md` into every session's memory section via `registerMemoryPromptSupplement`, provides the `swarm_read` + `compact` tools, and registers the `swarm-compact` CompactionProvider so context-ceiling compaction resumes from the agent's own handoff note |
| Memory never consolidates — agent forgets recent work | `memory-core` (bundled, configured) | Vanilla openclaw ships `memory-core` with `dreaming` off; oasis-claw enables it by default — a nightly light→REM→deep sweep promotes recent recalls into durable `MEMORY.md` and writes a Dream Diary |
| Clawhub skills install with zero security review | `clawhub-skill-audit` | Auto-fires an Opus 4.7 audit on every newly installed skill (SKILL.md + bundled scripts), writes an immutable JSON trail, and optionally quarantines `block`-verdict skills before they're loaded by an agent |
| LLM provider is hardcoded per session | `model-switcher` | `setmodel` agent tool + `/setmodel` slash command for hot-swapping the active model without a recreate; optional `allowedProviders` lock-down |
| No native voice (TTS / streaming STT) | `oasis-voice` | Registers as openclaw `SpeechProvider` + `RealtimeTranscriptionProvider`; lite tier is Piper TTS + Moonshine STT, runnable on a laptop CPU |
| No headless browser tool — vendored from upstream | `browser` | Chromium via Playwright with control-auth, SSRF guards, and `evaluateEnabled` forced off-by-default at our config layer; pinned + audited per [AUDIT_LOG.md](./AUDIT_LOG.md) |

### Security

openclaw's upstream `external-content.ts` runs regex patterns on inbound content passively. `prompt-injection-reporting` adds the complementary agent-side layer: when the model recognises an attempt, it calls `report_injection`, which writes a tamper-evident signed entry to the attack log and fires an operator alert. Both layers run simultaneously — they target different failure modes.

`secrets-vault` ensures the gateway is never an accidental credential exfiltration path. Plaintext never appears in tool-call history, JSONL transcripts, or memory supplements. The only path to re-materialization is through tool calls that explicitly request the secret, scoped to the plugin's stateDir.

`clawhub-skill-audit` closes the supply-chain gap. Every newly installed skill in the workspace is fed to Opus 4.7 via a forced-tool-use call and graded against a concrete catalogue of malicious patterns: prompt-injection in SKILL.md, credential exfiltration, exfil over curl/webhooks, persistence backdoors, supply-chain `curl|sh`, sandbox-evasion, and explicit attempts to disable other oasis-claw plugins. Verdicts are `pass` / `warn` / `block`; `block` can optionally move the skill to a quarantine directory. The audit trail is one immutable JSON file per skill at `~/.openclaw/logs/skill-audits/YYYY/MM/DD/<auditId>.json`.

### Explainability

Every LLM input, output, and tool call is written to an append-only JSONL file by `session-history`. This is structural transparency: the transcript exists regardless of what the model says it did or didn't do.

### Auditability

`dot-swarm` makes cross-session coordination state observable. `.swarm/state.md` and `.swarm/queue.md` are human-readable files you can inspect, diff, and version-control. The agent reads and writes them via structured tools (`swarm_read`, `compact`) — there is no hidden state. Combined with `session-history`'s JSONL transcripts and `memory-core`'s durable `MEMORY.md`, you have a full audit trail: what the agent knew (memory supplement + memory-core recall), what it did (tool calls + transcript), and what it decided to carry forward (compact handoff note).

---

## Running with Docker

The runtime image bakes all eleven extensions in at build time. Credentials come from `.env`. The build also pulls in pinned Chromium + Playwright via the `browser` plugin (~400MB on top of bookworm-slim). See [AUDIT_LOG.md](./AUDIT_LOG.md) for the per-plugin audit verdicts that gate every release.

```sh
cp .env.example .env
# Fill in ANTHROPIC_API_KEY (or another provider — see below),
# OASIS_TELEGRAM_BOT_TOKEN, OASIS_TELEGRAM_CHAT_ID

make rebuild        # first boot: builds image, starts container
make healthz        # → {"ok":true}
make logs           # tail gateway logs
make smoke          # plugin registration smoke test (mock API, no live LLM)
```

### Make targets

| Target | What it does | When to use |
|---|---|---|
| `make restart` | Restart gateway process | After `openclaw config set` changes |
| `make recreate` | Recreate container | After `.env` changes (creds, cortex swap) |
| `make rebuild` | Rebuild image + recreate | After Dockerfile or entrypoint changes |
| `make smoke` | Plugin smoke test | After plugin code changes |
| `make token` | Print gateway auth token | Needed for direct API calls |
| `make healthz` | Authenticated healthz probe | Verify gateway is up |
| `make assets-list` | Per-bot avatar inventory (size, dims, hash) | Checking which face each bot wears |
| `make assets-set BOT=x AVATAR=f.png` | Swap a bot's avatar + reload | Giving a bot a new face (add `RELOAD=0` to defer) |
| `make assets-show BOT=x` | Open a bot's current avatar | Eyeballing before/after a swap |

### Managing bot avatars

Each bot's face is an image under `workspace/avatars/`, referenced from the
`- **Avatar:** avatars/<file>` line in its `IDENTITY.md`. The
[`scripts/claw-assets`](scripts/claw-assets) CLI (wrapped by the `assets-*`
targets above) keeps the three copies of that fact consistent:

- **Running bot** — writes the image into the live volume *as the `node` user*
  (the container drops `CAP_DAC_OVERRIDE`, so a plain `docker cp` lands files
  the gateway can't read), repoints `IDENTITY.md` if the file extension
  changed, and restarts the gateway so the persona reload takes effect.
- **Stopped persona bot** — stages the image + `IDENTITY.md` edit into the
  gitignored `bots/<name>/workspace/` overlay instead; the next
  `make -C bots up BOT=<name>` / `seed` applies it. Nimbus has no overlay —
  its volume is the source of record.
- **Telegram profile photo** — `scripts/claw-assets telegram-photo <bot>`
  validates the current avatar against Telegram's limits (square, ≥512px,
  <5 MB, static) and hands off to BotFather `/setuserpic`; the Bot API cannot
  set a bot's own photo, so that last click stays manual.

`scripts/claw-assets theme <bot>` probes the pinned openclaw build for
theme/appearance config keys and reports honestly when there are none (the
current pin exposes no UI theming — personality lives in the avatar plus
`IDENTITY.md`/`SOUL.md`).

---

## Language cortex hot-swapping

The gateway is provider-agnostic. The active language model is a single config value — swap it without touching plugin code, rebuilding the image, or rewriting prompts. Works the same whether you're running locally on a MacBook or deployed to EC2.

Set `OPENCLAW_DEFAULT_MODEL` in `.env` and run `make recreate`. The entrypoint writes it into `openclaw.json` on every boot.

```bash
# Anthropic (default)
ANTHROPIC_API_KEY=sk-ant-...
OPENCLAW_DEFAULT_MODEL=anthropic/claude-sonnet-4-6

# Google Gemini
GEMINI_API_KEY=...
OPENCLAW_DEFAULT_MODEL=gemini/gemini-2.0-flash
# also: gemini/gemini-2.5-pro  gemini/gemini-2.5-flash

# OpenAI
OPENAI_API_KEY=...
OPENCLAW_DEFAULT_MODEL=openai/gpt-4o
# also: openai/o3  openai/o4-mini  openai/gpt-4o-mini

# Amazon Bedrock (IAM credentials, no API key)
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
OPENCLAW_DEFAULT_MODEL=bedrock/anthropic.claude-sonnet-4-5-v1:0
# also: bedrock/amazon.nova-pro-v1:0  bedrock/meta.llama3-70b-instruct-v1:0

# Ollama — fully local, runs on the Mac host
# Pull the model first: `ollama pull llama3.3`
# No API key. compose already wires host.docker.internal → host gateway.
OPENCLAW_DEFAULT_MODEL=ollama/llama3.3
# also: ollama/qwen3  ollama/mistral  ollama/deepseek-r1
```

**Live swap** (no recreate needed if the API key is already in the container):

```sh
make shell
openclaw config set agents.defaults.model.primary "gemini/gemini-2.0-flash"
exit
make restart
```

The `.env.example` in the repo documents all four priority providers with every model string and required credential.

---

## Auditing the openclaw plugins we vendor in

Most of what we ship is our own code. But for capabilities that already exist upstream (the `browser` plugin is the canonical example — Chromium+Playwright with auth, SSRF guards, profiles, ~39k LOC), forking is the wrong shape and an unaudited `npm install` is worse. Our policy:

1. **Vendor, don't fork.** We `cp -R` the upstream plugin into `extensions/<id>/` and record the source commit in `extensions/<id>/UPSTREAM`. The vendored tree is buildable as-is; any local modifications live as numbered patches in `extensions/<id>/patches/` and are also applied to `src/` so there's a single working tree.
2. **Three layered pins, separately bumpable.** For plugins with binary dependencies, we pin (a) the openclaw plugin source SHA, (b) any JS library version (e.g. `playwright-core`), and (c) the binary blob revision (e.g. Chromium revision). A CVE at any one layer can be addressed without touching the others. The Dockerfile asserts the pinned binary path exists at build time so a silently-republished build trips the build, not a deploy.
3. **Audit before merge.** Every vendored plugin is fed to `clawhub-skill-audit` in `--inspect` mode (Opus 4.7, multi-turn, with budgeted file inspection from the plugin source tree). Verdicts of `pass` / `warn` / `block` and the full inspection trail are written under `vendor/sandbox-skill-audit/_meta/<id>.audit-verdict.json`. Server-side rule: any high-severity unaudited path or medium+ auditability finding caps the verdict at `warn` and blocks `pass`. For the `browser` plugin we ran four targeted audit slices (broad / auth / SSRF / evaluate / AI-loop) to drive `pct_visible` above 70% on the security-sensitive surface. The verdict files and the runbook are in [AUDIT_LOG.md](./AUDIT_LOG.md).
4. **Findings become entrypoint config, not aspirational docs.** The browser audit found that upstream defaults `evaluateEnabled = true`. The fix isn't a doc note; it's a literal line in [`scripts/runtime-entrypoint.sh`](scripts/runtime-entrypoint.sh) that writes `browser.evaluateEnabled = false` into `openclaw.json` on every boot. Removing that line requires writing the per-session opt-in + audit-log patches first (CLAW-015).
5. **Refresh, don't auto-merge.** The CLAW-016 weekly job (`scripts/refresh-browser-plugin.sh`) `rsync`s upstream into a scratch tree, replays our patches, re-runs the audit, and either opens a PR (success) or an issue (conflict / new high-severity finding). The refresh job is the **only** mechanism by which upstream code reaches a deployed image — until the PR merges, our `extensions/browser/` stays at the pinned SHA. That property is load-bearing: it converts "supply-chain drift" into "a normal commit on top, gated by an audit."
6. **Upstream-bumps publish to the same log.** Every audit verdict, refresh PR, and CVE response gets a timestamped row in [AUDIT_LOG.md](./AUDIT_LOG.md). It's the single place to see what's been audited, when, by what model, with what verdict, and what mitigations are in force.

When a Chromium CVE drops in the gap window between Google's patch and Playwright's release, our mitigations in priority order are: (a) tighten `navigation-guard` allowlist via patch + rebuild, (b) flip `enabledByDefault: false` as a kill switch (voice/messaging stay up; only browser-tool agents are affected), (c) build our own Chromium tarball as escalation. The runbook lives in [extensions/browser/UPSTREAM](./extensions/browser/UPSTREAM).

---

## Plugins

### `extensions/prompt-injection-reporting`

Agent-callable `report_injection` tool. The model invokes it when it detects what it believes is a prompt-injection attempt. The plugin:

- Appends a signed JSONL entry to the attack log (`~/.openclaw/logs/attacks/`)
- Emits a Telegram alert to the operator chat (if configured)
- Returns acknowledgement to the model so it can continue with hardened behaviour

The cross-cutting `adversarial.test.ts` (22 tests) lives here as the end-to-end backstop for the security feature set.

### `extensions/secrets-vault`

AES-256-GCM at-rest secrets store. The agent never sees the plaintext after deposit — it gets an opaque handle that re-materializes only inside tool calls that explicitly request it:

- `deposit_secret` tool — the model invokes this when the user pastes a credential
- Redaction hook — runs before any history write so plaintext can't slip into JSONL transcripts
- Optional Telegram deposit confirmations

### `extensions/approval-gate`

Human-in-the-loop approval surface:

- `forward_captcha` agent tool — sends CAPTCHA images via Telegram and returns the operator's typed solution

Library code awaiting core integration (re-exported from the plugin entry):

- `loadApiApprovalPolicy`, `checkApiApproval`, `requestApiApproval`, `handlePotentialApiApprovalResponse` — utility functions for HTTP request approval policy. These need to be invoked from openclaw's HTTP middleware layer; that integration point doesn't yet exist in vanilla upstream.

Browser navigation approvals are handled entirely by upstream's `approvals.exec` infrastructure — no plugin code required, just configuration. See [`extensions/approval-gate/README.md`](./extensions/approval-gate/README.md) for the config recipe.

### `extensions/session-history`

Append-only JSONL session transcripts hooked at `llm_input`, `llm_output`, and `tool_call` events. Includes the `sandbox-isolation.test.ts` invariant suite which verifies the JSONL writer never escapes its configured `logDir` even under adversarial path inputs.

### `extensions/dot-swarm`

Memory prompt supplement that injects the contents of `.swarm/state.md`, `.swarm/queue.md`, and any other configured peer files into the agent's memory section at session start. Registers via `api.registerMemoryPromptSupplement` — **non-exclusive**, so it coexists cleanly with `memory-core`, `memory-lancedb`, `memory-wiki`, and `active-memory` rather than competing for the `kind: "memory"` slot.

Also registers a `swarm_read` agent tool for explicit mid-session re-reads (when stigmergic state has been updated by a sibling agent or the operator).

Configuration:

```json
{
  "plugins": {
    "entries": {
      "dot-swarm": {
        "swarmDir": "/path/to/repo/.swarm",
        "includeFiles": ["state.md", "queue.md", "memory.md"],
        "maxBytes": 32768,
        "registerSwarmReadTool": true
      }
    }
  }
}
```

If `swarmDir` is omitted, the plugin probes `$PWD/.swarm` first and falls back to `~/.openclaw/.swarm`. Tracks under oasis-x ORG-030.

### `extensions/clawhub-skill-audit`

Auto-runs a security audit against every newly installed clawhub skill. The plugin subscribes to openclaw's `registerSkillsChangeListener` (so it fires the moment `clawhub install` finishes) and also performs a debounced periodic filesystem scan (so first-boot skills and out-of-band installs aren't missed). Each newly-seen `(skillId, contentHash)` pair triggers a single Opus 4.7 audit:

- The skill's `SKILL.md` and all bundled `.sh`/`.py`/`.js`/`.ts`/`.md`/etc. files are wrapped in `<<<FILE>>>` sentinels and sent to the auditor as untrusted data
- The auditor is forced to call an `emit_audit` tool, returning structured JSON (`verdict`, `risk_score`, `summary`, `findings[]`)
- One immutable JSON record per audit is written to `~/.openclaw/logs/skill-audits/YYYY/MM/DD/<auditId>.json` — never overwritten, never deleted by the plugin
- `warn`/`block` verdicts trigger an operator Telegram alert if the bot creds are configured
- `block` verdicts optionally move the skill directory to `quarantineDir` (with a `QUARANTINED.txt` marker pointing to the audit id)

The threat model targets recent supply-chain incidents in agent-skill registries: hidden prompt-injection in `SKILL.md`, credential harvesting (`~/.ssh`, `~/.aws`, env dumps), exfiltration over webhooks/pastebin/DNS, persistence via cron/launchctl/rc files, destructive ops, `curl|sh` typosquats, and explicit attempts to disable other oasis-claw plugins (`approval-gate`, `secrets-vault`, `prompt-injection-reporting`).

Configuration:

```json
{
  "plugins": {
    "entries": {
      "clawhub-skill-audit": {
        "anthropicApiKey": "...",
        "auditModel": "claude-opus-4-7",
        "skillsDirs": ["./skills", "~/.openclaw/skills"],
        "auditLogDir": "~/.openclaw/logs/skill-audits",
        "quarantineDir": "~/.openclaw/quarantine/skills",
        "telegramBotToken": "...",
        "telegramAlertChatId": "...",
        "pollIntervalMs": 30000
      }
    }
  }
}
```

`anthropicApiKey` falls back to the `ANTHROPIC_API_KEY` env var if unset (so you don't have to copy the key into `openclaw.json`). `auditModel` defaults to `claude-opus-4-7` — the strong audit model is the point of the plugin, only override for cost-trial. With `quarantineDir` unset, the plugin is audit-only: it will log and alert but never move files.

### Memory & lifecycle — `memory-core` + `dot-swarm`

Private memory and shared coordination are deliberately separate concerns.

**Private memory** is the bundled upstream `memory-core` plugin — openclaw's default `memory` slot. It indexes `MEMORY.md` + `memory/*.md` and exposes `memory_search` / `memory_get`. oasis-claw enables its `dreaming` sweep (off in vanilla openclaw) so consolidation actually runs:

```json
{
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "dreaming": { "enabled": true, "frequency": "0 3 * * *", "timezone": "America/New_York" }
        }
      }
    }
  }
}
```

The nightly light→REM→deep sweep ranks recent recalls, promotes durable ones into `MEMORY.md`, and writes a Dream Diary. Without it, recall works but memory never grows — the agent "forgets" recent work.

**Shared coordination** is `dot-swarm` — the `.swarm/` stigmergy surface. Beyond injecting `state.md` + `queue.md` into the memory prompt, it provides the `compact` tool and the `swarm-compact` `CompactionProvider`: the agent writes a handoff note into `.swarm/state.md`, and at the context ceiling openclaw's compaction serves that note back instead of a generic summary. Activated by `agents.defaults.compaction.provider: "swarm-compact"`, which the runtime entrypoint pins.

### Configuration reference

Each plugin reads its own block under `plugins.entries` in `~/.openclaw/openclaw.json`. The runtime entrypoint (`scripts/runtime-entrypoint.sh`) merges these automatically from environment variables on each boot — you don't edit the JSON directly.

```json
{
  "plugins": {
    "entries": {
      "prompt-injection-reporting": {
        "telegramBotToken": "...",
        "telegramAlertChatId": "...",
        "attackLogDir": "~/.openclaw/logs/attacks"
      },
      "secrets-vault": { "secretsDir": "~/.openclaw/state/secrets" },
      "approval-gate": { "telegramBotToken": "...", "telegramChatId": "..." },
      "session-history": { "logDir": "~/.openclaw/logs/history" },
      "clawhub-skill-audit": {
        "auditLogDir": "~/.openclaw/logs/skill-audits",
        "skillsDirs": ["~/.openclaw/skills"]
      }
    }
  }
}
```

### Upstream features we deliberately do not duplicate

| Upstream | What it does | Our relationship |
|---|---|---|
| `src/infra/approval-handler-*` | Generic exec-approval routing (Telegram, Discord, Slack delivery channels) | `approval-gate` configures it via `approvals.exec`; previously had a stub `browser-approvals.ts` here that has been pruned |
| `src/security/external-content.ts` `SUSPICIOUS_PATTERNS` | Regex-based prompt injection detection on inbound external content | Complementary to `prompt-injection-reporting` (voluntary agent self-report); both run simultaneously |
| `extensions/active-memory/` | Bounded blocking memory sub-agent that injects relevant memory into context | Adjacent to `dot-swarm` (which targets static `.swarm/` file injection rather than sub-agent recall) |
| `extensions/memory-core/`, `memory-lancedb/`, `memory-wiki/` | Pluggable memory backends | `dot-swarm` registers via `registerMemoryPromptSupplement`, not `kind: "memory"`, so it's a peer not a competitor |
| `extensions/diagnostics-otel/` | OpenTelemetry diagnostics export | Complementary to `session-history` JSONL writer; runs together |
| `extensions/telegram/` | Full Telegram channel plugin (user conversations) | Different from our slim `telegram.ts` HTTP wrappers (operator alerts only) |

If upstream ships something that subsumes one of our extensions, prune ours when bumping the pin.

---

## Why a wrapper, not a fork

We tried the fork pattern twice (`MikeHLee/hyperclaw`, `MikeHLee/oasis-claw-archive-2026-03`). Both drifted thousands of commits behind upstream within a few months. The actual IP — a security plugin and an adversarial test suite — is small (≈7 commits of substance) and already plugin-shaped: it imports `openclaw/plugin-sdk` and registers via the standard `register(api)` surface. The fork was scaffolding around the plugin, not substance.

By keeping openclaw as a submodule and our plugins as first-class code in this repo:

- Upstream upgrades are a single tag bump in `.gitmodules` — no merge conflicts on 7,000+ commits of unrelated changes
- Upstream security fixes (gateway secret redaction, hello-ok auth, hook fallback bypass, session identity scoping) are inherited automatically on the next bump
- Our plugins ship as standard npm packages on top of any compatible openclaw release
- The container-native deployment story is cleaner: one Dockerfile, no patching

## Upstream pin

`vendor/openclaw/` is pinned to **`v2026.4.26`** (commit `be8c24633a`). The pin is deliberate: we bump it on a schedule, never automatically, so we control when upstream changes land.

### Bumping the openclaw pin

```sh
cd vendor/openclaw
git fetch --tags
git checkout v2026.X.Y          # whatever the new stable tag is
cd ../..
git add vendor/openclaw .gitmodules
git commit -m "chore: bump openclaw to v2026.X.Y"
```

Before bumping, audit the upstream changelog at `vendor/openclaw/CHANGELOG.md` for changes that affect:

- Plugin SDK surface (`packages/plugin-sdk/`, `src/plugins/hook-types.ts`) — would require updates to our plugins' `register()` signatures
- `src/security/external-content.ts` — adjacent to `prompt-injection-reporting`
- `src/infra/approval-handler-*` — what `approval-gate` re-exports as library code targets
- Any new extensions that overlap with what we ship; prune ours if upstream is now better

## Layout

```
oasis-claw/
  vendor/openclaw/             # git submodule, pinned to v2026.4.26
  extensions/
    prompt-injection-reporting/  # report_injection tool + signed attack log + Telegram alert
    secrets-vault/               # AES-256-GCM at-rest store + deposit_secret + redaction hook
    approval-gate/               # forward_captcha tool + API approval library code
    session-history/             # append-only JSONL transcripts + sandbox-isolation invariants
    dot-swarm/                   # .swarm/ stigmergy: prompt supplement + swarm_read/compact tools + swarm-compact CompactionProvider
    clawhub-skill-audit/         # Opus 4.7 auto-audit of newly installed skills + JSON audit trail
    model-switcher/              # setmodel tool + /setmodel slash; hot-swap LLM provider mid-session
    oasis-voice/                 # speech + realtime-STT provider (Piper TTS + Moonshine STT lite tier)
    browser/                     # VENDORED: openclaw browser plugin (Chromium/Playwright); evaluate off-by-default
  AUDIT_LOG.md                 # per-plugin audit verdict log; gates every release
  scripts/
    runtime-entrypoint.sh        # mints token, links plugins, merges config, execs gateway
    smoke-runner.mjs             # plugin-registration smoke test (mock API, no live gateway)
  archive/
    hyperclaw-fork-patches/    # the 7 commits from the deprecated fork, kept as patches
  Dockerfile.runtime           # full runtime image: openclaw + tsx + sharp + Chromium + our 10 plugins
  docker-compose.runtime.yml   # loopback-only port binding, cap_drop ALL, non-root
  Makefile                     # restart / recreate / rebuild / logs / healthz / smoke
  .env.example                 # all provider keys + OPENCLAW_DEFAULT_MODEL documented
  README.md
  LICENSE                      # MIT, matching upstream openclaw
```

## Local development

```sh
git clone --recurse-submodules https://github.com/oasis-main/oasis-claw.git
cd oasis-claw
pnpm install
pnpm test
```

## CI + branch model

This repo follows the standard oasis-x branch model: push experiments freely to `dev`, merge to `main` requires approval AND green CI. Three workflows in `.github/workflows/`:

| Workflow | Trigger | Blocks merge? | What it does |
|---|---|---|---|
| [`test.yml`](.github/workflows/test.yml) | PR + push to `dev`/`main` | **Yes** (on `main`) | `pnpm -r run test` + plugin smoke + per-extension `tsc --noEmit` |
| [`image-build.yml`](.github/workflows/image-build.yml) | PR touching Dockerfile / entrypoint / extensions | No (informational) | Builds the runtime image, asserts the pinned Chromium revision lands, posts image size + pin status to the PR summary |
| [`refresh-browser.yml`](.github/workflows/refresh-browser.yml) | Weekly cron (Mon 09:00 UTC) + manual | N/A (opens its own PR/issue) | Runs [`scripts/refresh-browser-plugin.sh`](scripts/refresh-browser-plugin.sh) — refreshes the vendored `browser` plugin against upstream openclaw, replays our patches, re-runs the audit cohort live, opens a PR on success or an issue on conflict/regression |

Live LLM audits run on **refresh only**. Routine PRs trust the pre-PR audit cohort that gated the change; re-auditing on every PR would burn API credits without adding coverage we don't already have. The refresh job is the choke point through which upstream code reaches our deployed image — until its PR merges, `extensions/browser/` stays at the SHA recorded in [extensions/browser/UPSTREAM](extensions/browser/UPSTREAM).

Notifications are GitHub-native (PR comments, issue mentions, branch-protection failure emails). Telegram is reserved for user/operator workflows (`prompt-injection-reporting`, `approval-gate`, `clawhub-skill-audit`) and is not used for CI.

Branch protection on `main` (set in repo settings, not in YAML):
- Required status checks: `test` (all three jobs)
- Required reviews: 1
- Linear history, no direct pushes
- `dev` stays unprotected — fix on the fly

Secrets the workflows need:
- `ANTHROPIC_API_KEY` — only `refresh-browser.yml` uses this

## License

MIT, matching upstream openclaw. See [LICENSE](./LICENSE).

## Provenance

This repo replaces two earlier fork attempts:

- `MikeHLee/hyperclaw` (deleted 2026-04-29)
- `MikeHLee/oasis-claw-archive-2026-03` (archived in place)

The 7 substantive commits from the `hyperclaw-security` branch are preserved as patches under `archive/hyperclaw-fork-patches/`. The architecture decision to drop the fork is documented in [`oasis-x/.swarm/state.md`](https://github.com/oasis-main/oasis-x) under the 2026-04-29 handoff note.
