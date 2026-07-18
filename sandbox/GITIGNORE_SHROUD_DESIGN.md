# gitignore-shroud — "edit but don't see" for reach-mounted trees

**Status:** DESIGN · 2026-07-11 · epic EPIC-AGENTS · CLAW-043/044
**Motivation (Mike):** "a broad rule where the bot can edit gitignore[d] files,
but cannot see them unless we explicitly authorize on a per-session basis. The
redaction tool should be used for this a lot as well."

## The problem, stated honestly

When we mount a project tree into a bot (e.g. all of `Runes/` into Van Helsing),
that tree contains **gitignored files** — and gitignored is where the secrets
live: every oasis repo's `.env`, local key material, credential caches, private
notes. We want a fleet-wide posture where:

1. a bot can **edit** a gitignored file (write a config, template a value), but
2. **cannot read its contents** by default ("cannot see"),
3. unless **explicitly unlocked for that one session**, and
4. **redaction** scrubs secret-shaped values heavily throughout.

### Why this is not a pure-mount feature

Docker bind mounts are **read-only or read-write** — there is no "write-only"
mount, and a write-only file is useless anyway (you can't meaningfully edit what
you can't read). So **"edit but not see" cannot be enforced at the filesystem
layer with plain mounts.** It has to be enforced at the **openclaw tool layer**
(what the agent is allowed to see in a tool result), and made *safe* by the
**OS sandbox** (what can physically leave the namespace).

This is the honest framing: the shroud is an *app-layer visibility control*,
and the OS sandbox is what turns "the model shouldn't see this" into "even if it
did, it can't leave."

## Layered design

**Layer 0 — OS sandbox (LIVE).** `internal:true` + egress-proxy = no egress.
Hard guarantee: anything a compromised loop reads, gitignored or not, **cannot be
exfiltrated**. This is the floor that makes every layer above it a
defense-in-depth nicety rather than the sole wall.

**Layer 1 — gitignore discovery (build: CLAW-043).** At session start (and on a
refresh timer), for each reach tree that is a git repo, compute the ignored set:
```
git -C <tree> ls-files --others --ignored --exclude-standard
```
plus an always-shroud glob list independent of git status:
`.env*`, `*.key`, `*.pem`, `id_ed25519*`, `id_rsa*`, `credentials`, `*.secret`,
`*.p12`, `*.keystore`, `.netrc`. Write the union to a manifest the middleware
reads. (Trees that aren't git repos fall back to the glob list only.)

**Layer 2 — read-shroud middleware (build: CLAW-043).** An
`registerAgentToolResultMiddleware` handler that inspects file-read / Bash tool
results. If the accessed path ∈ ignored-set AND ∉ session unlock-list, replace
the **contents** with:
`«shrouded: <path> is gitignored — contents withheld; request per-session unlock»`
Metadata (exists / size / mode / mtime) still passes, so the bot knows the file
is there and can reason about *posture* (this is exactly what Van Helsing's
fortification role needs: "`~/.aws/credentials` exists, mode 600" without the
keys).

**Layer 3 — secrets-vault redaction (LIVE).** Already runs `tool_result_persist`
redaction: secret-shaped values (API keys, tokens, PEM blocks, high-entropy
strings) are masked in tool results for ALL files — gitignored, unlocked, or
plain. This is the "redaction used a lot" Mike asked for; it's already on. The
shroud (Layer 2) is the coarse filter (whole gitignored files); redaction is the
fine filter (secret-shaped substrings anywhere).

**Layer 4 — per-session unlock (build: CLAW-044).** To actually read a shrouded
file, the bot (or Mike) requests unlock of a specific path. Routes through the
existing `approval-gate` → Telegram (out-of-band) → Mike approves → path added to
the **session** unlock-list → shroud lifts for that path, this session only.
Never persists across sessions; a fresh session re-shrouds everything. Denials
and unlocks are appended to the signed audit log.

**Layer 5 — the edit path (RW mounts).** Where a bot legitimately edits (House in
`exp/`, ButterBolt in `oasis-hardware/`), mount RW. The write tool works; the
read-shroud still hides gitignored *contents* unless unlocked. So the bot can
write a templated change (`FOO=${NEW}`) into a `.env` **without having read the
old secret** — "edit without see." Reading the current value back requires the
Layer-4 unlock. This is the closest faithful realization of Mike's rule.

## Per-bot application

| Bot | Reach mode | Shroud behavior |
|---|---|---|
| Van Helsing | **RO** (mapper) | read-shroud + redaction; he audits posture, never needs secret values; unlock only if a specific finding requires it |
| House | RW (`exp/`) | read-shroud + redaction; edits configs blind; unlock a value only with Mike's per-session approval |
| ButterBolt | RW (`oasis-hardware/`, `oasis-firmware/`) | same |
| Kolmogorov / ClapTrap | RO (mostly) | read-shroud + redaction |

## Interim posture (TODAY, before CLAW-043/044 land)

Live now: **Layer 0 (sandbox)** + **Layer 3 (secrets-vault redaction)**.
So mounting all of `Runes/` RO into Van Helsing right now means:
- ✅ secrets **cannot be exfiltrated** (sandbox, proven by the adversarial tests);
- ✅ secret-shaped values are **redacted from the model** (secrets-vault);
- ⚠️ **gap:** a gitignored file that is *not* secret-shaped (a local notes file,
  a config without obvious key patterns) could still be read into the model's
  context. It can't leave — but it's visible. CLAW-043 closes this.

For Van Helsing's fortification role (posture, not values) the residual is low.
For the RW editing bots (House/ButterBolt), **do not grant RW to a secret-bearing
tree until CLAW-043/044 land** — the "edit blind" guarantee depends on the
read-shroud existing.

## Build constraint discovered (2026-07-12) — the bundled-plugin gate

The design's Layer-2 seam, `api.registerAgentToolResultMiddleware` — the *only*
seam that transforms a tool result **before the model reasons on it** and that
also exposes the tool **args** (the path we classify on) — is gated by openclaw:

- `registry.ts` refuses the registration unless the plugin's `origin === "bundled"`
  (pushes an error diagnostic and no-ops otherwise), AND the manifest declares
  `contracts.agentToolResultMiddleware` for each targeted runtime.
- Our oasis extensions are `--link`-installed into `/app/extensions/` → origin
  `"config"`/`"global"`, **never `"bundled"`**. So a plain extension calling this
  API silently does nothing.

**Why the obvious fallback is not enough.** The non-gated alternative,
`api.on("tool_result_persist", …)` (what `secrets-vault` uses), runs at
*persistence* and only sees the result **message**, not the tool **args** — so it
cannot classify by path. It can only pattern-redact content, which secrets-vault
already does (Layer 3). It therefore cannot deliver a path-based "cannot see this
gitignored file" guarantee. **Path-based shrouding requires the bundled seam.**

**Resolution — bundle at image-build time.** openclaw's bundled extensions live
at `/usr/local/lib/node_modules/openclaw/dist/extensions/<id>/` (compiled
`index.js` + `index.d.ts` + `openclaw.plugin.json`). To arm the shroud:
1. compile `extensions/operating-system-sandbox` (TS → JS);
2. `Dockerfile.runtime` `COPY`s the compiled extension into openclaw's
   `dist/extensions/operating-system-sandbox/` *after* the `npm i -g openclaw`
   step (so every image build re-injects it; robust to version bumps as long as
   the discovery path holds — a known coupling to watch on openclaw upgrades);
3. manifest declares `contracts.agentToolResultMiddleware: ["pi"]` (done);
4. `runtime-entrypoint.sh` injects `plugins.entries.operating-system-sandbox.config`
   = `{ reachRoots: ["/reach/runes", …], enforce: true }` (like other plugins).
5. do **not** add it to the `--link` install list (that would make it non-bundled).

**Built already (seam-agnostic, 19/19 unit assertions green):**
`src/shroud-policy.ts` (glob floor + secret-dir + gitignore manifest + session
unlock, all pure) and `src/shroud-transform.ts` (path extraction + metadata-
preserving placeholder + result rewrite), plus `index.ts` orchestration
(manifest TTL cache, JSONL audit, Read + coarse-Bash handling, loud boot warning
if the seam is inert). Remaining: the compile + Dockerfile `COPY` + entrypoint
config + a **live shroud-fires** verification. An `enforce:false` dry-run mode is
built so the manifest can be validated before arming.

## Bundling VERIFIED (2026-07-13)

Rebuilt image `01595dc7ecb1` with the extension baked into
`/usr/local/lib/node_modules/openclaw/dist/extensions/operating-system-sandbox/`.
Verified in throwaway containers (the running Nimbus/VH fleet untouched):

- **Discovery:** `openclaw plugins inspect operating-system-sandbox` →
  `Origin: bundled`, `Source: …/dist/extensions/…/index.js`, `Version: 2026.6.11`.
  So the file-drop is enough for openclaw to treat it as a stock/bundled plugin
  (discovery `readdir`s the extensions root and derives candidates from each
  valid `openclaw.plugin.json` — no separate registry edit needed).
- **Enablement:** bundled plugins are **disabled by default**; the entrypoint's
  `merge_config` writes `plugins.entries.operating-system-sandbox = {enabled:true,
  config:{reachRoots, enforce, auditPath}}` from `OASIS_SHROUD_ROOTS` /
  `OASIS_SHROUD_ENFORCE`, and `plugins list` then shows it **enabled**.
- **Seam accepted:** gateway boot produced **no** `only bundled plugins can
  register agent tool result middleware` / `must declare contracts…` error — the
  gate (origin:bundled + `contracts.agentToolResultMiddleware:["pi"]`) is
  satisfied.
- **Verification gotcha (recorded so we don't re-trip it):** bundled plugins load
  **silently** — none of the stock plugins emit a `[plugins] <id> loaded` line;
  that line is only for `--link`'d plugins. So a missing log line is NOT evidence
  the plugin didn't load. Verify bundled plugins via `plugins list`/`inspect`.
- **Remaining = live-fire:** a real agent `Read` of a mounted `.env` returns the
  shroud placeholder instead of contents. This needs a model turn (API creds), so
  it lands at the Van Helsing recreate — which starts in `enforce:0` **dry-run**
  (logs would-shroud to `shroud-audit.jsonl`, contents still pass) for manifest
  review before arming.

## Queue

- **CLAW-043** — gitignore discovery (Layer 1) + read-shroud tool-result
  middleware (Layer 2). **Code + tests + bundling VERIFIED** (see above);
  **remaining = live-fire at the VH recreate.**
- **CLAW-044** — per-session unlock (Layer 4) via `approval-gate` + Telegram;
  signed audit of shroud denials/unlocks; surface denied-reads in the portal
  injection dashboard (CLAW-041) next to denied-egress. `index.ts` has the
  `unlockedFor(sessionId)` stub ready to wire.
