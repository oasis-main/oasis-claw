# oasis-claw

A wrapper repo around upstream [openclaw](https://github.com/openclaw/openclaw) that adds Oasis-built security and coordination plugins. **No fork** — upstream lives as a git submodule pinned to a specific tag, and our additions are plain plugins consumed via the openclaw plugin SDK.

## Why a wrapper, not a fork

We tried the fork pattern twice (`MikeHLee/hyperclaw`, `MikeHLee/oasis-claw-archive-2026-03`). Both drifted thousands of commits behind upstream within a few months. The actual IP — a security plugin and an adversarial test suite — is small (≈7 commits of substance) and already plugin-shaped: it imports `openclaw/plugin-sdk` and registers via the standard `register(api)` surface. The fork was scaffolding around the plugin, not substance.

By keeping openclaw as a submodule and our plugins as first-class code in this repo:

- Upstream upgrades are a single tag bump in `.gitmodules` — no merge conflicts on 7,000+ commits of unrelated changes
- Upstream security fixes (gateway secret redaction, hello-ok auth, hook fallback bypass, session identity scoping) are inherited automatically on the next bump
- Our plugins ship as standard npm packages on top of any compatible openclaw release
- The container-native deployment story is cleaner: `FROM openclaw:vX.Y.Z` + `pnpm add @oasis/hyperclaw-security`

## Layout

```
oasis-claw/
  vendor/openclaw/             # git submodule, pinned to upstream tag
  extensions/
    prompt-injection-reporting/  # report_injection tool + attack logger + Telegram alert
                                 # (other source files in src/ are pending Stage-2 relocation
                                 # into secrets-vault, approval-gate, session-history)
  archive/
    hyperclaw-fork-patches/    # the 7 commits from the deprecated fork, kept as patches
                               # for historical reference
  README.md
  LICENSE                      # MIT, matching upstream openclaw
```

## Plugins

The deprecated fork bundled five concerns into one `hyperclaw-security` plugin. The plan is to decompose into focused single-responsibility plugins. Stage 1 (rename + narrow) is done; Stages 2–4 are tracked under oasis-x ORG-049.

### `extensions/prompt-injection-reporting` *(active — narrowed in Stage 1)*

Agent-callable `report_injection` tool — the model invokes it when it detects what it believes is a prompt-injection attempt in its input. The plugin:

- Appends a signed JSONL entry to the attack log (`~/.openclaw/logs/attacks/`)
- Emits a Telegram alert to the operator chat (if configured)
- Returns acknowledgement to the model so it can continue with hardened behavior

Configuration via `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "prompt-injection-reporting": {
        "telegramBotToken": "...",
        "telegramAlertChatId": "...",
        "attackLogDir": "~/.openclaw/logs/attacks"
      }
    }
  }
}
```

### Pending decomposition (Stage 2 of ORG-049)

The current `prompt-injection-reporting/src/` directory still contains source files that belong to other plugins. They are kept colocated (and unwired from the narrowed `register()`) until they're relocated into their own packages.

| Pending plugin | Will contain | Source files awaiting move |
|---|---|---|
| `secrets-vault` | AES-256-GCM at-rest store, `deposit_secret` tool, redaction hook | `secrets-store.ts`, `tools/deposit-secret.ts`, `hooks/secrets-redact.ts`, `secrets-store.test.ts` |
| `approval-gate` | Browser URL approval gate, API approval gate, CAPTCHA forwarding | `browser-approvals.ts`, `api-approval-gate.ts`, `tools/forward-captcha.ts`, `browser-approvals.test.ts` |
| `session-history` | JSONL session transcripts hooked at `llm_input`/`llm_output` | `history-logger.ts`, `sandbox-isolation.test.ts` |
| `_shared/telegram` | Tiny shared helper used by reporting + approval-gate | `telegram.ts` |

The cross-cutting `adversarial.test.ts` (22 tests) stays with `prompt-injection-reporting` since adversarial behavior is the security backstop this plugin tests end-to-end.

## Planned plugins (not yet scaffolded)

| Plugin | Purpose | Tracked as |
|---|---|---|
| `dot-swarm` | Register as `kind: "memory"` backend; injects `.swarm/state.md` + `queue.md` into session context, enabling stigmergic coordination across sessions and instances | oasis-x ORG-030 |
| `agent-primitives` | `sleep` / `dream` / `compact` tools — the three lifecycle primitives. All tool-call shaped, no core loop changes required. `sleep` yields for delayed re-invocation; `dream` consolidates trail.log into memory.md; `compact` performs context-ceiling handoff via state snapshot | oasis-x ORG-050 |

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
