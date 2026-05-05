# oasis-claw

Vanilla [openclaw](https://github.com/openclaw/openclaw) is a capable AI gateway, but it ships without answers to three production concerns: **what happens when the model is manipulated**, **where credentials go when the user pastes them**, and **how you audit what the agent actually did**. oasis-claw is a thin plugin layer that fills exactly those gaps — no fork, no divergence from upstream, just six focused extensions on top of the standard plugin SDK.

## What this adds over vanilla openclaw

| Gap in vanilla openclaw | oasis-claw plugin | What it does |
|---|---|---|
| No agent-side injection reporting | `prompt-injection-reporting` | Agent calls `report_injection` when it detects manipulation; signed JSONL entry + Telegram operator alert |
| Credentials land in plaintext in LLM context | `secrets-vault` | AES-256-GCM at-rest vault; agent gets an opaque handle, not plaintext; redaction hook strips secrets before any JSONL write |
| Sensitive actions execute without human sign-off | `approval-gate` | `forward_captcha` tool routes CAPTCHA images through Telegram and returns the operator's typed solution; API approval policy hooks for HTTP requests |
| No immutable session transcript | `session-history` | Append-only JSONL at `llm_input`, `llm_output`, and `tool_call` events; sandbox invariant tests verify the writer never escapes its `logDir` |
| Agent loses all context on session reset | `dot-swarm` | Injects `.swarm/state.md`, `.swarm/queue.md`, and peer files into every session's memory section via `registerMemoryPromptSupplement`; agent always knows where it left off |
| No explicit agent lifecycle signals | `agent-primitives` | `sleep`, `dream`, and `compact` tools let the agent voluntarily yield, consolidate memory, and hand off cleanly at context ceiling |

### Security

openclaw's upstream `external-content.ts` runs regex patterns on inbound content passively. `prompt-injection-reporting` adds the complementary agent-side layer: when the model recognises an attempt, it calls `report_injection`, which writes a tamper-evident signed entry to the attack log and fires an operator alert. Both layers run simultaneously — they target different failure modes.

`secrets-vault` ensures the gateway is never an accidental credential exfiltration path. Plaintext never appears in tool-call history, JSONL transcripts, or memory supplements. The only path to re-materialization is through tool calls that explicitly request the secret, scoped to the plugin's stateDir.

### Explainability

Every LLM input, output, and tool call is written to an append-only JSONL file by `session-history`. This is structural transparency: the transcript exists regardless of what the model says it did or didn't do. `agent-primitives` adds behavioural transparency: when the agent sleeps, consolidates memory, or hands off, it writes a structured event to `.swarm/trail.log` with the reason and parameters — a complete ledger of agent lifecycle decisions.

### Auditability

`dot-swarm` makes cross-session state observable. `.swarm/state.md`, `.swarm/queue.md`, and `.swarm/memory.md` are human-readable files you can inspect, diff, and version-control. The agent reads from them and writes to them via structured tools — there is no hidden state. Combined with `session-history`'s JSONL transcripts, you have a full audit trail: what the agent knew (memory supplement), what it did (tool calls + transcript), and what it decided to carry forward (compact handoff note).

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

### `extensions/agent-primitives`

Three lifecycle tools — `sleep`, `dream`, `compact` — each tool-call shaped, no core loop changes required. Current state: filesystem-side fully wired, host integration is a stub pending ORG-050.

| Tool | What the stub does | Host-integration TODO (ORG-050) |
|---|---|---|
| `sleep(reason, resumeAfterMs)` | Writes a SLEEP event to `.swarm/trail.log`, returns the scheduled `resumeAt` | Pause the agent loop and schedule re-invocation via cron / systemd-timer |
| `dream(topic?, maxFiles?)` | Reads recent JSONL session files from `historyDir`, appends a DREAM section to `.swarm/memory.md` | Sub-agent invocation that actually distills transcripts into prose |
| `compact(handoffNote, sessionTag?)` | Appends a HANDOFF section to `.swarm/state.md`, writes a COMPACT event | Signal harness to finish the turn and start a fresh session — once dot-swarm is enabled, the new session reads state.md back automatically |

The split is deliberate: agent-primitives owns the *content* of each lifecycle event (what gets written where), and host integration owns the *lifecycle* (when to actually pause/restart). This matches the Claude Code compact pattern — the tool emits the snapshot, the harness handles the reset.

Configuration:

```json
{
  "plugins": {
    "entries": {
      "agent-primitives": {
        "swarmDir": "/path/to/repo/.swarm",
        "historyDir": "~/.openclaw/logs/history"
      }
    }
  }
}
```

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
      "session-history": { "logDir": "~/.openclaw/logs/history" }
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
    dot-swarm/                   # memory prompt supplement: injects .swarm/ files into context
    agent-primitives/            # sleep / dream / compact lifecycle tools (stubs, FS side wired)
  scripts/
    runtime-entrypoint.sh        # mints token, links plugins, merges config, execs gateway
    smoke-runner.mjs             # plugin-registration smoke test (mock API, no live gateway)
  archive/
    hyperclaw-fork-patches/    # the 7 commits from the deprecated fork, kept as patches
  Dockerfile.runtime           # full runtime image: openclaw + tsx + sharp + our 6 plugins
  docker-compose.runtime.yml   # loopback-only port binding, cap_drop ALL, non-root
  Makefile                     # restart / recreate / rebuild / logs / healthz / smoke
  .env.example                 # all provider keys + OPENCLAW_DEFAULT_MODEL documented
  README.md
  LICENSE                      # MIT, matching upstream openclaw
```

## Running with Docker

The runtime image bakes all six extensions in at build time. Credentials come from `.env`.

```sh
cp .env.example .env
# Fill in ANTHROPIC_API_KEY (or another provider — see .env.example),
# OASIS_TELEGRAM_BOT_TOKEN, OASIS_TELEGRAM_CHAT_ID

make rebuild        # first boot: builds image, starts container
make healthz        # → {"ok":true}
make logs           # tail gateway logs
make smoke          # plugin registration smoke test (mock API, no live LLM)
```

### LLM provider switching

Set `OPENCLAW_DEFAULT_MODEL` in `.env` and run `make recreate`. The entrypoint writes it into `openclaw.json` on every boot.

```bash
# Gemini (needs GEMINI_API_KEY)
OPENCLAW_DEFAULT_MODEL=gemini/gemini-2.0-flash

# OpenAI (needs OPENAI_API_KEY)
OPENCLAW_DEFAULT_MODEL=openai/gpt-4o

# Bedrock (needs AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION)
OPENCLAW_DEFAULT_MODEL=bedrock/anthropic.claude-sonnet-4-5-v1:0

# Ollama on Mac host (pull model first: `ollama pull llama3.3`)
OPENCLAW_DEFAULT_MODEL=ollama/llama3.3
```

Live switch without recreate: `make shell` → `openclaw config set agents.defaults.model.primary "gemini/gemini-2.0-flash"` → `make restart`.

### Make targets

| Target | What it does | When to use |
|---|---|---|
| `make restart` | Restart gateway process | After `openclaw config set` changes |
| `make recreate` | Recreate container | After `.env` changes (creds, model switch) |
| `make rebuild` | Rebuild image + recreate | After Dockerfile or entrypoint changes |
| `make smoke` | Plugin smoke test | After plugin code changes |
| `make token` | Print gateway auth token | Needed for direct API calls |
| `make healthz` | Authenticated healthz probe | Verify gateway is up |

## Local development

```sh
git clone --recurse-submodules https://github.com/oasis-main/oasis-claw.git
cd oasis-claw
pnpm install
pnpm test
```

## License

MIT, matching upstream openclaw. See [LICENSE](./LICENSE).

## Provenance

This repo replaces two earlier fork attempts:

- `MikeHLee/hyperclaw` (deleted 2026-04-29)
- `MikeHLee/oasis-claw-archive-2026-03` (archived in place)

The 7 substantive commits from the `hyperclaw-security` branch are preserved as patches under `archive/hyperclaw-fork-patches/`. The architecture decision to drop the fork is documented in [`oasis-x/.swarm/state.md`](https://github.com/oasis-main/oasis-x) under the 2026-04-29 handoff note.
