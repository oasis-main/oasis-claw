# oasis-claw

A wrapper repo around upstream [openclaw](https://github.com/openclaw/openclaw) that adds Oasis-built security and coordination plugins. **No fork** — upstream lives as a git submodule pinned to a specific tag, and our additions are plain plugins consumed via the openclaw plugin SDK.

## Why a wrapper, not a fork

We tried the fork pattern twice (`MikeHLee/hyperclaw`, `MikeHLee/oasis-claw-archive-2026-03`). Both drifted thousands of commits behind upstream within a few months. The actual IP — a security plugin and an adversarial test suite — is small (≈7 commits of substance) and already plugin-shaped: it imports `openclaw/plugin-sdk` and registers via the standard `register(api)` surface. The fork was scaffolding around the plugin, not substance.

By keeping openclaw as a submodule and our plugins as first-class code in this repo:

- Upstream upgrades are a single tag bump in `.gitmodules` — no merge conflicts on 7,000+ commits of unrelated changes
- Upstream security fixes (gateway secret redaction, hello-ok auth, hook fallback bypass, session identity scoping) are inherited automatically on the next bump
- Our plugins ship as standard npm packages on top of any compatible openclaw release
- The container-native deployment story is cleaner: `FROM openclaw:vX.Y.Z` + `pnpm add @oasis/hyperclaw-security`

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
- `src/security/external-content.ts` — adjacent to our `prompt-injection-reporting`
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
  archive/
    hyperclaw-fork-patches/    # the 7 commits from the deprecated fork, kept as patches
                               # for historical reference
  README.md
  LICENSE                      # MIT, matching upstream openclaw
```

## Plugins

The deprecated fork bundled five concerns into one `hyperclaw-security` plugin. We've decomposed into focused single-responsibility plugins. The remaining ORG-049 work is to scaffold the planned plugins (Stage 3) and re-run the test suite against the openclaw submodule runtime (Stage 4).

### `extensions/prompt-injection-reporting`

Agent-callable `report_injection` tool — the model invokes it when it detects what it believes is a prompt-injection attempt in its input. The plugin:

- Appends a signed JSONL entry to the attack log (`~/.openclaw/logs/attacks/`)
- Emits a Telegram alert to the operator chat (if configured)
- Returns acknowledgement to the model so it can continue with hardened behavior

The cross-cutting `adversarial.test.ts` (22 tests) lives here as the end-to-end backstop for the security feature set.

### `extensions/secrets-vault`

AES-256-GCM at-rest secrets store. The agent never sees the plaintext after deposit — it gets an opaque handle that re-materializes only inside tool calls that explicitly request it. Provides:

- `deposit_secret` tool — the model invokes this when the user pastes a credential
- Redaction hook — runs before any history write so plaintext can't slip into JSONL transcripts
- Optional Telegram deposit confirmations

### `extensions/approval-gate`

Human-in-the-loop approval surface. Currently wired:

- `forward_captcha` agent tool — sends CAPTCHA images via Telegram and returns the operator's typed solution

Library code awaiting core integration (re-exported from the plugin entry):

- `loadApiApprovalPolicy`, `checkApiApproval`, `requestApiApproval`, `handlePotentialApiApprovalResponse` — utility functions for HTTP request approval policy. These need to be invoked from openclaw's HTTP middleware layer; that integration point doesn't yet exist in vanilla upstream.

Browser navigation approvals are handled entirely by upstream's `approvals.exec` infrastructure — no plugin code is required, just configuration. See [`extensions/approval-gate/README.md`](./extensions/approval-gate/README.md) for the config recipe.

### `extensions/session-history`

Append-only JSONL session transcripts hooked at `llm_input`, `llm_output`, and `tool_call` events. Includes the `sandbox-isolation.test.ts` invariant suite which verifies the JSONL writer never escapes its configured `logDir` even under adversarial path inputs.

### Configuration

Each plugin reads its own block under `plugins.entries` in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "prompt-injection-reporting": { "telegramBotToken": "...", "telegramAlertChatId": "...", "attackLogDir": "~/.openclaw/logs/attacks" },
      "secrets-vault": { "secretsDir": "~/.openclaw/state/secrets" },
      "approval-gate": { "telegramBotToken": "...", "telegramChatId": "..." },
      "session-history": { "logDir": "~/.openclaw/logs/history" }
    }
  }
}
```

### Upstream features we deliberately do not duplicate

These exist in `vendor/openclaw/` and we use them rather than reimplementing:

| Upstream | What it does | Our relationship |
|---|---|---|
| `src/infra/approval-handler-*` | Generic exec-approval routing (Telegram, Discord, Slack delivery channels) | `approval-gate` configures it via `approvals.exec`; previously had a stub `browser-approvals.ts` here that has been pruned |
| `src/security/external-content.ts` `SUSPICIOUS_PATTERNS` | Regex-based prompt injection detection on inbound external content (emails, web pages) | Complementary to our `prompt-injection-reporting` (voluntary agent self-report); both run simultaneously |
| `extensions/active-memory/` | Bounded blocking memory sub-agent that injects relevant memory into prompt context before reply | Adjacent to the planned `dot-swarm` plugin (which targets static `.swarm/` file injection rather than sub-agent memory recall) |
| `extensions/memory-core/`, `memory-lancedb/`, `memory-wiki/` | Pluggable memory backends keyed by `kind: "memory"` | The planned `dot-swarm` will register as `kind: "memory"` peer to these |
| `extensions/diagnostics-otel/` | OpenTelemetry diagnostics export | Complementary to our `session-history` JSONL writer; can run together |
| `extensions/telegram/` | Full Telegram channel plugin (user conversations) | Different use case from our slim `telegram.ts` HTTP wrappers (operator alerts only) |

If upstream ships something that subsumes one of our extensions, prune ours when bumping the pin.

### A note on `telegram.ts` duplication

Three plugins talk to the Telegram Bot API. Rather than carrying a `_shared/telegram` workspace package for ~110 lines of stable HTTP wrapper code, each plugin keeps its own slimmed copy:

- `prompt-injection-reporting/src/telegram.ts` — `sendTelegramMessage` only (~30 LOC)
- `secrets-vault/src/telegram.ts` — `sendTelegramMessage` only (~30 LOC)
- `approval-gate/src/telegram.ts` — `sendTelegramMessage` + `sendTelegramPhoto` (~110 LOC)

The dead `editTelegramMessage` helper that the original bundle carried (never called anywhere) was dropped. If a real shared utility need emerges later, this is small enough to extract then.

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

The three lifecycle tools — `sleep`, `dream`, `compact` — each tool-call shaped (no core loop changes required). Current state: filesystem-side fully wired, host integration is a stub.

| Tool | What the stub does | Host-integration TODO (ORG-050) |
|---|---|---|
| `sleep(reason, resumeAfterMs)` | Writes a SLEEP event to `.swarm/trail.log`, returns the scheduled `resumeAt` | Pause the agent loop and schedule re-invocation via cron / systemd-timer |
| `dream(topic?, maxFiles?)` | Reads recent JSONL session files from `historyDir`, appends a DREAM section to `.swarm/memory.md` with file/byte counts | Sub-agent invocation that actually distills transcripts into prose |
| `compact(handoffNote, sessionTag?)` | Appends a HANDOFF section to `.swarm/state.md`, writes a COMPACT event | Signal harness to finish the turn and start a fresh session — once dot-swarm is enabled, the new session reads state.md back automatically |

The split is deliberate: agent-primitives owns the *content* of each lifecycle event (what gets written where), and host integration owns the *lifecycle* (when to actually pause/restart). This matches Claude Code's compact pattern — the tool emits the snapshot, the harness handles the reset. Tracks under oasis-x ORG-050.

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

## Architecture: agent lifecycle as tools, not core changes

Three primitives map cleanly onto the existing tool-registration surface:

- **sleep** — agent voluntarily yields (`sleep(reason, resume_after_ms)`). Host scheduler re-invokes after delay. Use cases: waiting on Telegram approval, polling external state, rate-limit backoff. Maps to the `ScheduleWakeup` pattern.
- **dream** — agent triggers memory consolidation. Reads recent `trail.log` and session JSONL, distills into `.swarm/memory.md`. Use cases: end-of-session cleanup, low-activity intervals.
- **compact** — graceful handoff at context-ceiling. Writes state snapshot to `.swarm/state.md`, emits a `COMPACT` event, signals host to restart with fresh context. Use cases: long-running tasks approaching token limits.

All three write to the plugin's stateDir under `.swarm/`, which means they integrate naturally with the planned dot-swarm memory backend.

## Local development

```sh
git clone --recurse-submodules https://github.com/oasis-main/oasis-claw.git
cd oasis-claw

# Build openclaw against our plugins
cd vendor/openclaw
pnpm install
pnpm add file:../../extensions/hyperclaw-security
pnpm test -- ../../extensions/hyperclaw-security
```

## Container-native deployment

The same image works for local CLI sandboxing and as a deployable per-tenant agent service:

```dockerfile
FROM openclaw:v1.X.Y
RUN pnpm add @oasis/hyperclaw-security
COPY openclaw.json /root/.openclaw/openclaw.json
```

Mount an EBS-backed `.swarm/` volume for persistent coordination state; `swarm init` runs in user-data on EC2, locally `swarm init` runs once at workspace setup.

## License

MIT, matching upstream openclaw. See [LICENSE](./LICENSE).

## Provenance

This repo replaces two earlier fork attempts:

- `MikeHLee/hyperclaw` (deleted 2026-04-29)
- `MikeHLee/oasis-claw-archive-2026-03` (archived in place)

The 7 substantive commits from the `hyperclaw-security` branch are preserved as patches under `archive/hyperclaw-fork-patches/`. The architecture decision to drop the fork is documented in [`oasis-x/.swarm/state.md`](https://github.com/oasis-main/oasis-x) under the 2026-04-29 handoff note.
