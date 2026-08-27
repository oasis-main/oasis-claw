#!/usr/bin/env bash
# shell-portability: linux-only  -- this is the image ENTRYPOINT (Dockerfile.runtime:297);
# it never runs on a host, so the image bash 5 applies, not macOS bash 3.2.
#
# Container entrypoint for oasis-claw-runtime.
#
# 1. Ensure ~/.openclaw exists; mint a gateway auth token if not provided.
# 2. Run `openclaw plugins install --link --force` for each of our 11 baked-in
#    extensions so the loader registers them in the persisted plugin registry
#    that lives in ~/.openclaw (volume-persisted). memory-core is bundled with
#    openclaw (not in /app/extensions) — it is configured, not installed.
# 3. Pin gateway.bind / gateway.mode / token / Control UI allowlist + per-plugin
#    config under plugins.entries.<id>.config (no `path` key — that's handled by
#    the install registry the previous step populated).
# 4. exec `openclaw gateway` on the configured port.
#
# Re-run safe: `--force` overwrites the install record; existing user config
# values are preserved by the merge below.

set -euo pipefail

CONFIG_DIR="${HOME}/.openclaw"
CONFIG_FILE="${CONFIG_DIR}/openclaw.json"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
BIND="${OPENCLAW_GATEWAY_BIND:-lan}"

# ---- SQLITE_TMPDIR — the memory index silently stops without it ---------
# /tmp in these containers is a 64 MB tmpfs. SQLite spills large transactions
# to temp files under SQLITE_TMPDIR (falling back to /tmp), so a big memory
# reindex exhausts it and the CLI reports "Memory index failed: database or
# disk is full" while /home/node/.openclaw still has ~69 GB free.
#
# Found live on Nimbus 2026-08-10 (CLAW-082 phase 2): the index sat at
# 561/568 files across three consecutive passes, and the 5 new .swarm corpus
# files never landed. Re-running the SAME command with SQLITE_TMPDIR pointed
# at the volume completed it immediately — 568/568 files, 2,518 chunks.
#
# Exported here so BOTH the gateway (which syncs on session start and on
# search) and any `docker exec openclaw memory index` inherit it. TMPDIR is
# deliberately left alone: redirecting all temp writes into the persisted
# volume would accumulate there instead of being cleared with the tmpfs.
export SQLITE_TMPDIR="${CONFIG_DIR}/tmp"

mkdir -p "${CONFIG_DIR}" "${CONFIG_DIR}/workspace" "${CONFIG_DIR}/logs/attacks" \
         "${CONFIG_DIR}/logs/history" "${CONFIG_DIR}/state/secrets" \
         "${CONFIG_DIR}/.swarm" "${SQLITE_TMPDIR}"

# ---- gateway auth token (mint + persist on first boot) -----------------
if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  TOKEN_FILE="${CONFIG_DIR}/.gateway-token"
  if [[ -s "${TOKEN_FILE}" ]]; then
    OPENCLAW_GATEWAY_TOKEN="$(cat "${TOKEN_FILE}")"
  else
    OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32)"
    printf '%s' "${OPENCLAW_GATEWAY_TOKEN}" > "${TOKEN_FILE}"
    chmod 600 "${TOKEN_FILE}"
  fi
  export OPENCLAW_GATEWAY_TOKEN
fi

# ---- .swarm/ first-boot seed: REMOVED 2026-08-10 (CLAW-082) -------------
# This block used to write a "First-boot placeholder" state.md + queue.md into
# ${CONFIG_DIR}/.swarm, which was also dot-swarm's swarmDir. Nothing ever
# replaced them, so six of seven bots injected that placeholder into the memory
# prompt of every session from 2026-07-08 to 2026-08-10. dot-swarm now points at
# the bot's REAL project board (OASIS_SWARM_DIR, set per bot in its compose
# overlay) and is DISABLED when a bot has no board. A private placeholder board
# has no remaining reader, so seeding one is dead work.

# ---- pre-install: scrub known-bad keys from the persisted config -----
# Each `openclaw plugins install --link` below validates the existing
# config before linking. If a prior boot wrote a key the current schema
# rejects (e.g. our own d081484 -> f8f4e9e fix removed
# `tools.media.audio.provider`; the persisted file still had it), the
# install fails and the plugin doesn't link. The Python merge block at
# the END of this script would clean things up, but only AFTER all the
# installs have already errored. So: do a minimal pre-pass HERE to
# remove keys we know to be stale, BEFORE the install loop runs.
#
# This is idempotent and append-only safe: keys not present in the
# config are silently ignored.
python3 - "${CONFIG_FILE}" <<'PY'
import json
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
if not config_path.exists():
    sys.exit(0)
try:
    config = json.loads(config_path.read_text())
except json.JSONDecodeError:
    sys.exit(0)

# Known schema-invalid keys from prior boots:
audio = config.get("tools", {}).get("media", {}).get("audio")
if isinstance(audio, dict):
    audio.pop("provider", None)

browser = config.get("browser")
if isinstance(browser, dict):
    browser.pop("dataDir", None)

# models.providers.<id> requires a `models` array per strict zod schema
# (zod-schema.core.ts:352). Backfill an empty array if missing.
providers = config.get("models", {}).get("providers", {})
if isinstance(providers, dict):
    for pid, pcfg in providers.items():
        if isinstance(pcfg, dict) and "models" not in pcfg:
            pcfg["models"] = []

# Stale plugin references from prior boots. When a plugin is removed from
# the image (e.g. agent-primitives, retired into dot-swarm), the persisted
# config still carries it: a plugins.load.paths entry AND a plugins.entries
# block. The load.paths entry is FATAL — `openclaw plugins install --link`
# validates the whole config first, and a load path that no longer exists
# on disk aborts EVERY install in the loop below. Prune load.paths entries
# whose directory is missing (self-healing for any future plugin removal),
# and drop orphaned entries blocks that have no matching install path.
plugins_cfg = config.get("plugins")
if isinstance(plugins_cfg, dict):
    load = plugins_cfg.get("load")
    if isinstance(load, dict) and isinstance(load.get("paths"), list):
        load["paths"] = [
            p for p in load["paths"] if isinstance(p, str) and Path(p).exists()
        ]
    entries = plugins_cfg.get("entries")
    if isinstance(entries, dict):
        entries.pop("agent-primitives", None)
        # sleep-cycle: its config schema tightened (additionalProperties:false)
        # when the setInterval-daemon design was replaced by the cron-driven
        # tool. A volume-persisted config with the old daemon keys
        # (idleGraceMinutes, replayQueued, dozeReply, maxDeferMinutes,
        # idleCheckIntervalMinutes) fails validation and crash-loops the
        # gateway. Drop any sleep-cycle.config key outside the current schema.
        sc = entries.get("sleep-cycle")
        if isinstance(sc, dict) and isinstance(sc.get("config"), dict):
            allowed = {
                "enabled", "timezone", "dozeAt", "deepSleepAt", "wakeAt",
                "sessionMatch", "wakingSummary", "contextNap",
                "semanticsEndpoint", "semanticsModel",
            }
            for k in list(sc["config"]):
                if k not in allowed:
                    sc["config"].pop(k, None)

config_path.write_text(json.dumps(config, indent=2) + "\n")
PY

# ---- compile role.yaml if present (CLAW-047) -----------------------------
# A bot whose compose overlay mounts bots/<bot>/role.yaml at /app/role.yaml
# gets its four enforcement layers DERIVED from that single file instead of
# hand-maintained env vars. The compiler reads the ACTIVE exec tier for the
# bot's current `phase`, extracts tools.profile + alsoAllow, and exports
# shell variables that the merge_config + exec-approvals blocks below consume
# (same variable names: OASIS_EXEC_ALLOWLIST, etc.). Bots WITHOUT a role.yaml
# fall through to the existing env-driven behavior (backward-compatible).
ROLE_FILE="${OASIS_ROLE_FILE:-/app/role.yaml}"
if [[ -f "${ROLE_FILE}" ]]; then
  _role_exports=$(python3 /usr/local/bin/compile-role.py "${ROLE_FILE}" 2>&1)
  if [[ $? -eq 0 && -n "${_role_exports}" ]]; then
    eval "${_role_exports}"
    echo "[entrypoint] role compiled: ${OASIS_ROLE_NAME:-?} phase=${OASIS_ROLE_PHASE:-?}" \
         "exec=${_ROLE_EXEC_ACTIVE_COUNT:-0} active + ${_ROLE_EXEC_DORMANT_COUNT:-0} dormant" \
         "(${_ROLE_EXEC_DORMANT_TIERS:-none})"
  else
    echo "[entrypoint] WARN: role compilation failed for ${ROLE_FILE}; falling back to env" >&2
  fi
fi

# ---- install our 11 extensions via the openclaw plugin registry -------
# `--link` points the registry at /app/extensions/<id>/ (read-only image) so
# we don't duplicate code. `--force` is incompatible with --link, so we skip
# install if the plugin is already in the registry from a prior boot.
#
# secrets-vault triggers the dangerous-code detector (env var + network send,
# which is the intentional Playwright form-fill path that keeps plaintext out
# of tool-call history). We pass --dangerously-force-unsafe-install only for
# that plugin because it's our code and we accept the override.
#
# `browser` is vendored from upstream openclaw (extensions/browser/UPSTREAM
# records the pinned SHA + playwright-core + chromium revision). It ships
# with `evaluateEnabled` forced to `false` at the top-level config block
# below — that's the load-bearing override identified by the CLAW-014
# evaluate-slice audit (see AUDIT_LOG.md). Per-session opt-in only.
declare -A PLUGINS=(
  [prompt-injection-reporting]=""
  [secrets-vault]="--dangerously-force-unsafe-install"
  [approval-gate]=""
  [session-history]=""
  # oasis-reviewer: independent before_tool_call reviewer (CLAW-074,
  # .swarm/UNIFIED_REVIEWER.md). Skeleton phase = SHADOW (audit-only, never
  # blocks). Gated per-bot via OASIS_REVIEWER_ENABLE so it lands on yesman first.
  [oasis-reviewer]=""
  # oasis-reach: inter-bot mail (CLAW-076). Installs fleet-wide but stays DISABLED
  # unless the bot's compose sets OASIS_REACH_ENABLE=1 (only bots that mount
  # /reach/mail). Provides reach_send/reach_inbox/reach_read + an unread-count
  # memory supplement; the host relay (claw-mail-relay) owns all comms policy.
  [oasis-reach]=""
  [dot-swarm]=""
  # oasis-find: root-confined filesystem search (CLAW-082 phase 3). Gives the
  # agent fs_glob / fs_grep / fs_help — the cheap exact-search primitives
  # Claude Code has and openclaw does not. Installs fleet-wide but DISABLES
  # ITSELF when OASIS_FIND_ROOTS names no readable directory (hello-world has
  # no reach mounts at all).
  [oasis-find]=""
  # clawhub-skill-audit's audit-prompt.ts intentionally contains the
  # exact "dynamic code execution" string patterns the auditor looks
  # FOR in third-party skills. openclaw's install-time scanner reads
  # those patterns and refuses to install. False positive on our own
  # auditor's source — same shape as the secrets-vault override.
  [clawhub-skill-audit]="--dangerously-force-unsafe-install"
  [model-switcher]=""
  [oasis-voice]=""
  # oasis-voice-control (CLAW-107 phase 1): voice_list / voice_set. A SEPARATE
  # extension from oasis-voice on purpose — tools need a contracts.tools block,
  # and oasis-voice cannot declare one without dropping out of the gateway
  # entirely (see its own _contracts_NOTE). Registers tools only, no providers.
  [oasis-voice-control]=""
  [oasis-semantics]=""
  # browser vendored from upstream openclaw; ships legitimate child_process
  # usage for Chromium launch — same false-positive shape as secrets-vault.
  [browser]="--dangerously-force-unsafe-install"
  # sleep-cycle drives gateway RPCs (sessions.compact/reset/send) through the
  # openclaw CLI via child_process — the CLI already speaks the gateway's WS
  # protocol correctly, so we spawn it rather than reimplement the handshake.
  # Same install-scanner false-positive shape as browser.
  [sleep-cycle]="--dangerously-force-unsafe-install"
)

# Always run install --link. The command is idempotent (a no-op when
# the registry record already matches), and our previous "already
# linked" probe was matching CONFIG entries from openclaw.json that
# had no corresponding registry record — silently skipping a plugin
# whose actual install had failed on a prior boot. Bug history:
# without this loop, oasis-voice + clawhub-skill-audit appeared in
# the CLI's plugin list (because their entries.* config blocks lived
# in openclaw.json) yet never got loaded by the gateway. Running
# install --link unconditionally costs 1-2s per plugin at boot but
# makes the "is this plugin actually wired up" question deterministic.
for p in "${!PLUGINS[@]}"; do
  echo "[entrypoint] linking plugin: ${p}"
  # shellcheck disable=SC2086
  # `timeout` guards against a plugin whose module import never returns (e.g. a
  # plugin that starts a persistent timer at register/import time — bit us on
  # sleep-cycle 2026-07-13). Without it a single hung install wedges the whole
  # boot before the gateway ever starts. 90s is far above a normal 1-2s link.
  if ! timeout 90 openclaw plugins install --link ${PLUGINS[$p]} "/app/extensions/${p}" 2>&1 | tail -3; then
    echo "[entrypoint] WARN: failed to link ${p} (rc=$?, continuing)" >&2
  fi
done

# ---- merge gateway + per-plugin config into openclaw.json --------------
python3 - "${CONFIG_FILE}" "${BIND}" "${PORT}" "${OPENCLAW_GATEWAY_TOKEN}" <<'PY'
import json
import os
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
bind = sys.argv[2]
port = int(sys.argv[3])
token = sys.argv[4]

home = Path(os.environ["HOME"])
config: dict = {}
if config_path.exists():
    try:
        config = json.loads(config_path.read_text())
    except json.JSONDecodeError:
        config = {}

config.setdefault("gateway", {})
config["gateway"]["bind"] = bind
config["gateway"]["mode"] = "local"
config["gateway"].setdefault("port", port)
config["gateway"].setdefault("auth", {})
config["gateway"]["auth"]["token"] = token
config["gateway"]["auth"].setdefault("mode", "token")

allowed = [f"http://localhost:{port}", f"http://127.0.0.1:{port}"]
config["gateway"].setdefault("controlUi", {})
if not config["gateway"]["controlUi"].get("allowedOrigins"):
    config["gateway"]["controlUi"]["allowedOrigins"] = allowed

# ---- inbound Telegram channel (upstream plugin) ------------------------
# Single-bot setup: reuse OASIS_TELEGRAM_BOT_TOKEN for inbound user chat
# AND outbound operator alerts. TELEGRAM_BOT_TOKEN (the upstream plugin's
# native env name) takes precedence if set, so a future split into two
# bots only needs adding TELEGRAM_BOT_TOKEN to .env without touching this.
# We use long-polling, dmPolicy=allowlist, allowFrom = operator user id.
# No public endpoint required.
#
# The token is written as a SECRET REF, never as a literal. openclaw's native
# form — {"source":"env","provider":"default","id":"<ENV_VAR>"} — is resolved at
# runtime, so openclaw.json holds a POINTER and no credential at rest. This was
# the fifth copy: the plugin-config dedupe (approval-gate, secrets-vault,
# prompt-injection-reporting, clawhub-skill-audit) never touched the native
# CHANNEL config, so a plaintext bot token stayed in every bot's openclaw.json.
# Van Helsing reported reading it and was right.
#
# SCOPE, precisely: this removes the persisted AT-REST copy (config volume,
# backups, `docker cp`, volume snapshots) and makes rotation a restart instead of
# a config rewrite. It does NOT hide the token from an agent that can exec —
# `agents.sandbox` is null on this fleet, so openclaw's env sanitizer
# (BLOCKED_ENV_VAR_PATTERNS) does not apply and `printenv` still resolves it.
# Containing THAT is the uid/netns exec sandbox, tracked separately.
inbound_env_name = (
    "TELEGRAM_BOT_TOKEN"
    if os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    else ("OASIS_TELEGRAM_BOT_TOKEN"
          if os.environ.get("OASIS_TELEGRAM_BOT_TOKEN", "").strip()
          else None)
)
operator_user_id = os.environ.get("OASIS_TELEGRAM_CHAT_ID", "").strip() or None
if inbound_env_name:
    channels = config.setdefault("channels", {})
    tg = channels.setdefault("telegram", {})
    tg["enabled"] = True
    # Assigned (not setdefault'd) so an existing plaintext token from a prior
    # boot is REPLACED by the ref rather than left in place.
    tg["botToken"] = {
        "source": "env",
        "provider": "default",
        "id": inbound_env_name,
    }
    tg["dmPolicy"] = "allowlist"
    # ── CLAW-091: Telegram media downloads need an EXPLICIT proxy ──────────
    # Setting HTTP_PROXY/HTTPS_PROXY is NOT enough, and the difference is the
    # whole bug. With only the env vars the plugin picks dispatcher mode
    # "env-proxy"; `usesTrustedTelegramExplicitProxy` (extensions/telegram/src/
    # bot/delivery.resolve-media.ts:188) returns true ONLY for mode
    # "explicit-proxy", so it passes trustExplicitProxyDns:false and the media
    # fetch is forced to resolve api.telegram.org with LOCAL pinned DNS first.
    # On the internal:true sandbox net there is no resolver, so every photo
    # fetch dies with EAI_AGAIN.
    #
    # That is not merely a dropped image. The poisoned update never completes,
    # the persisted offset stays pinned before it, and EVERY later message
    # queues behind it — House was hard-frozen this way on 2026-08-12 (update
    # 323675635, a photo; the operator's next two messages sat pending with 0
    # attempts). Text polling was unaffected the whole time, which is what made
    # it look like a hang rather than a network fault.
    #
    # Naming the SAME proxy explicitly flips the mode, which flips
    # trustExplicitProxyDns, which lets the proxy do the DNS. Derived from the
    # environment so it cannot drift from the egress proxy the bot actually has.
    _tg_proxy = (os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY") or "").strip()
    if _tg_proxy:
        tg["proxy"] = _tg_proxy
        print(f"[entrypoint] telegram: explicit proxy {_tg_proxy} (enables media-fetch DNS via proxy)")
    if operator_user_id and operator_user_id.lstrip("-").isdigit():
        existing_allow = tg.get("allowFrom") or []
        if operator_user_id not in existing_allow:
            existing_allow.append(operator_user_id)
        tg["allowFrom"] = existing_allow
    # Group adds disabled by default; require explicit opt-in via .env later.
    tg.setdefault("groups", {})
    # Faster recovery from a wedged getUpdates long-poll (CLAW-072). openclaw's
    # polling monitor force-restarts the channel after pollingStallThresholdMs of a
    # stuck poll (default 120s). The long-poll is timeout:30, so 75s (2.5x) trims
    # openclaw's own self-heal while staying safely above a healthy long-poll
    # (openclaw clamps to [30s, 10m]). NOTE the biggest stalls are macOS-sleep
    # wedges — recovered on wake; the fleet watchdog (make watchdog-install, 90s) is
    # the primary fast-recovery path. This is a modest secondary trim.
    tg["pollingStallThresholdMs"] = 75000
    # CLAW-073: OPEN THE NATIVE EXEC/PLUGIN APPROVAL DELIVERY ROUTE. The reviewer's
    # `escalate` returns openclaw's native {requireApproval}; openclaw's telegram
    # approval capability only opens a delivery route when the approver count is > 0
    # (dist approval-client-helpers isChannelExecApprovalClientEnabledFromConfig:
    # approverCount<=0 → disabled, EVEN with enabled="auto" and a valid turn-source
    # DM present). The approver list = channels.telegram.execApprovals.approvers ∪
    # commands.ownerAllowFrom; both were empty, so every escalate bounced "Plugin
    # approval unavailable (no approval route)". Setting ownerAllowFrom to the same
    # operator id as allowFrom (Mike) makes approverCount=1 → the route opens and
    # delivers "🛡️ … /approve <id> allow-once|allow-always|deny" to Mike's ORIGIN
    # DM, AND authorizes that id to RESOLVE via /approve. enabled stays default
    # "auto" (opens once an approver exists). No device pairing needed on the native
    # channel path. Fleet-wide + harmless on shadow bots (they never escalate).
    if operator_user_id and operator_user_id.lstrip("-").isdigit():
        commands_cfg = config.setdefault("commands", {})
        owner_allow = commands_cfg.get("ownerAllowFrom") or []
        if operator_user_id not in owner_allow:
            owner_allow.append(operator_user_id)
        commands_cfg["ownerAllowFrom"] = owner_allow

# ---- per-plugin config (registration is handled by `plugins install`) ----
plugins = config.setdefault("plugins", {})
entries = plugins.setdefault("entries", {})

# CLAW-073 / openclaw 2026.7.1 upgrade: `codex` was UNBUNDLED from core into a
# separate npm package (@openclaw/codex). On upgrade, core-plugin convergence
# (src/cli/update-cli/post-core-plugin-convergence.ts) finds the stale 4.26-era
# install record, sees the payload is gone, and tries to `npm install` it. Our
# egress proxy is fail-closed and denies registry.npmjs.org, so that returns
# E403 -> "startup migrations did not complete cleanly" -> THE GATEWAY REFUSES
# TO REPORT READY AND NEVER LISTENS. 6.11 tolerated this; 7.1 does not.
# Convergence drops records for plugins listed in `plugins.deny`, so denying
# codex is the config-only fix — no npm access, no weakening of the egress
# boundary. Remove this only if we ever actually want the codex plugin (which
# would require allowlisting the npm registry for the bots).
deny = plugins.setdefault("deny", [])
if "codex" not in deny:
    deny.append("codex")

TELEGRAM_KEYS = {"telegramBotToken", "telegramChatId", "telegramAlertChatId"}

# Keys that should ALWAYS reflect the current env, never the persisted
# value. Use this when a config field semantically belongs to the
# deployment topology (docker-compose layout, sidecar URL, etc.) rather
# than to operator preference. Persisted prior-boot values can otherwise
# pin a stale endpoint forever — bug history: oasis-voice's `endpoint`
# was setdefault'd, so a config written when the default was
# 127.0.0.1:8731 stuck after we changed the default to
# http://oasis-voice:8731 (sibling container), and the plugin kept
# resolving to the openclaw container's own loopback (no listener).
TOPOLOGY_KEYS = {"endpoint", "tts_voice", "reachRoots", "enforce", "swarmDir", "maxBytes"}

def merge_config(plugin_id, defaults, hooks=None):
    entry = entries.setdefault(plugin_id, {})
    entry["enabled"] = entry.get("enabled", True)
    cfg = entry.setdefault("config", {})
    for k, v in defaults.items():
        # Telegram creds + topology fields always reflect current env (so
        # rotating creds via `.env` + recreate works, and so that changing
        # the compose layout doesn't leave plugins pointing at the prior
        # endpoint). Other keys are user-overridable defaults.
        if k in TELEGRAM_KEYS or k in TOPOLOGY_KEYS:
            cfg[k] = v
        else:
            cfg.setdefault(k, v)
    if hooks:
        h = entry.setdefault("hooks", {})
        for k, v in hooks.items():
            h.setdefault(k, v)

# Telegram creds: each of the 4 alerting plugins (prompt-injection-reporting,
# secrets-vault, approval-gate, clawhub-skill-audit below) reads
# OASIS_TELEGRAM_BOT_TOKEN / OASIS_TELEGRAM_CHAT_ID from process.env directly
# at register() — same convention as ANTHROPIC_API_KEY below. Previously this
# copied the literal token into 4 separate entries.*.config blocks in
# openclaw.json (one persisted plaintext copy per plugin, readable via the
# bot's own `cat`); now there is exactly one copy of the secret at rest — the
# container's env — and nothing plugin-config-shaped to keep in sync on
# rotation. cfg.telegramBotToken/telegramChatId remain valid as an explicit
# manual override in openclaw.json, they're just never written here.
prompt_inj_cfg = {"attackLogDir": str(home / ".openclaw/logs/attacks")}
secrets_cfg = {"secretsDir": str(home / ".openclaw/state/secrets")}
approval_cfg = {}

merge_config("prompt-injection-reporting", prompt_inj_cfg)
merge_config("secrets-vault", secrets_cfg)
merge_config("approval-gate", approval_cfg)
merge_config(
    "session-history",
    {"logDir": str(home / ".openclaw/logs/history")},
    # Non-bundled plugins must explicitly opt in to llm_input/llm_output hooks.
    # session-history's whole purpose is recording the transcript, so this is
    # required for it to do its job.
    hooks={"allowConversationAccess": True},
)
# oasis-reviewer (CLAW-074, .swarm/UNIFIED_REVIEWER.md). The before_tool_call
# hook is only WIRED for a non-bundled plugin when it declares explicit hook
# policy (gateway-startup-plugin-ids.ts hasExplicitHookPolicyConfig); without
# this the plugin loads + register() runs but the gateway never invokes the hook
# (verified 2026-07-26: register fired, audit dir created, zero hook calls, while
# session-history captured the same turns). allowConversationAccess also lets the
# reviewer see the stated goal for its "act only in service of Mike's intent"
# principle — the constitution primes it to treat all such content as untrusted
# data. Skeleton config = SHADOW (audit-only, never blocks).
merge_config(
    "oasis-reviewer",
    # Per-bot rollout control (§10 of UNIFIED_REVIEWER.md): mode from env,
    # default SHADOW. Only a bot whose compose sets OASIS_REVIEWER_MODE=enforce
    # actually blocks/escalates; every other bot audits silently. VH must never
    # be flipped to enforce-with-widening — its constitution is read-only-analysis.
    {"mode": os.environ.get("OASIS_REVIEWER_MODE", "shadow"),
     "auditDir": str(home / ".openclaw/logs/reviewer")},
    hooks={"allowConversationAccess": True},
)
# mode is DEPLOYMENT-driven (per-bot rollout), so it must always reflect the env,
# not a stale persisted value — merge_config setdefaults config keys, which would
# otherwise pin whatever landed first. Force it every boot.
entries["oasis-reviewer"]["config"]["mode"] = os.environ.get("OASIS_REVIEWER_MODE", "shadow")
#
# ── LAYER 2 JUDGE MODEL PIN + OVERRIDE GRANT (CLAW-106, 2026-08-24) ───────────
# The reviewer passes OASIS_REVIEWER_MODEL to runtime.llm.complete() as `model`.
# openclaw REFUSES that parameter unless the plugin entry carries an explicit
# grant. The guard is assertAllowedModelOverride() in
#   vendor/openclaw/src/plugins/runtime/runtime-llm.runtime.ts:313
# reached from :408 only when a `model` value is present. It reads
#   cfg.plugins.entries["oasis-reviewer"].llm
# via resolvePluginLlmOverridePolicy() at :284. Note the path: `llm` is a
# SIBLING of `config` in PluginEntrySchema (config/zod-schema.ts:273-300), NOT a
# key inside it. `config` is z.record(z.unknown()), so an `llm` block misplaced
# under it VALIDATES and is then never read — a silent failure.
#
# Without the grant the judge throws "Plugin LLM completion cannot override the
# target model." on EVERY call. On a constitutionalReviewRequired bot (nimbus,
# helloworld) that fails CLOSED and denies every tool call. That was the
# 2026-08-24 16:50-20:08 UTC outage.
#
# The grant is DERIVED from the same env var that sets the pin, so the two can
# never drift apart: no OASIS_REVIEWER_MODEL means no grant at all, which is
# byte-identical to the pre-CLAW-106 safe state. A set value grants exactly
# itself and nothing else.
_reviewer_model = os.environ.get("OASIS_REVIEWER_MODEL", "").strip()
if _reviewer_model:
    # openclaw normalizes an allowlist entry with parseModelCatalogRef
    # (runtime-llm.runtime.ts normalizeAllowedModelRef), which requires the
    # provider/model form. A bare "claude-sonnet-5" parses to None and is
    # dropped, leaving hasConfiguredAllowedModels=True with an EMPTY set, which
    # throws "model override allowlist has no valid models" on every judged call.
    #
    # MEASURED 2026-08-24 in oasis-claw-house, three isolated probes:
    #   grant + "anthropic/claude-sonnet-5"  -> HTTP 200, reply "OK."
    #   no grant + any ref                   -> "cannot override the target model"
    #   grant + bare id in BOTH model and allowlist -> "allowlist has no valid models"
    #
    # Note what this corrects in the CLAW-106 write-up: a bare params.model on
    # its OWN is harmless — resolveSimpleCompletionSelectionForAgent resolves it
    # against the agent catalog and it returns 200. The bare form only becomes
    # fatal once the allowlist exists, because the allowlist does NOT get that
    # resolution step. So the outage had ONE cause (the missing grant); the bare
    # ref is a defect this fix INTRODUCES if left unguarded. Hence the assertion.
    if "/" not in _reviewer_model or _reviewer_model.startswith("/") or _reviewer_model.endswith("/"):
        raise SystemExit(
            f"[entrypoint] FATAL: OASIS_REVIEWER_MODEL is {_reviewer_model!r}, which is not "
            f"a provider/model reference. openclaw's parseModelCatalogRef requires the "
            f"provider/model form (for example 'anthropic/claude-sonnet-5'). A bare model id "
            f"is silently dropped from the override allowlist and denies every judged call."
        )
    entries["oasis-reviewer"]["llm"] = {
        "allowModelOverride": True,
        "allowedModels": [_reviewer_model],
    }
    print(f"[entrypoint] reviewer L2 judge model: {_reviewer_model} (override GRANTED, allowlist=1)")
else:
    # No pin -> no grant. The reviewer sends model=undefined, the guard at
    # runtime-llm.runtime.ts:408 never runs, and the judge inherits the agent's
    # own model. Strip any stale grant a previous boot persisted.
    entries["oasis-reviewer"].pop("llm", None)
    print("[entrypoint] reviewer L2 judge model: agent-default (no override, no grant)")
# oasis-reach (CLAW-076) inter-bot mail. enabled + peers are DEPLOYMENT-driven per
# bot (env from the bot's compose overlay), so force them every boot rather than
# letting merge_config pin a stale first value — same reasoning as the reviewer
# mode above. A bot with OASIS_REACH_ENABLE unset registers nothing.
merge_config("oasis-reach", {
    "enabled": os.environ.get("OASIS_REACH_ENABLE", "") == "1",
    "mailDir": os.environ.get("OASIS_REACH_MAILDIR", "/reach/mail"),
    "statePath": str(home / ".openclaw/reach-read.json"),
    "knownPeers": [p for p in os.environ.get("OASIS_REACH_PEERS", "").split(",") if p],
})
entries["oasis-reach"]["config"]["enabled"] = os.environ.get("OASIS_REACH_ENABLE", "") == "1"
entries["oasis-reach"]["config"]["knownPeers"] = [p for p in os.environ.get("OASIS_REACH_PEERS", "").split(",") if p]
# dot-swarm (CLAW-082, 2026-08-10): point swarmDir at the bot's REAL project
# board instead of its private container home.
#
# WHY this changed. Until now every bot ran swarmDir=~/.openclaw/.swarm — a path
# nothing else can see. Six of seven held ONLY the 2026-07-08 first-boot
# placeholder above, and dot-swarm injected that placeholder into the memory
# prompt of every session for a month. House mounted the real boards at
# /reach/oasis-swarm and /reach/claw-swarm and was still pointed at the
# placeholder. `.swarm` is a git-tracked, per-project planning artifact, so the
# right value is always a path inside the bot's own reach mounts.
#
# OASIS_SWARM_DIR is a TOPOLOGY key: force-set every boot, so re-pointing a bot
# in its compose overlay propagates on the next recreate. Empty => the bot has no
# board (hello-world has no reach mount at all) and dot-swarm is DISABLED rather
# than left injecting a placeholder.
#
# maxBytes is the shared prompt budget across state.md + queue.md. 24576 (~6K
# tokens, once per session) is chosen so every SMALL board renders in full
# (alignment_research 17,285 B, bounty-hunter 15,998 B, oasis-firmware 20,536 B)
# while the two large boards truncate with an explicit pointer. As of CLAW-082
# the reader splits that budget FAIRLY instead of consuming it in file order —
# the old behavior starved queue.md to empty on oasis-x/.swarm (state.md 57 KB,
# queue.md 195 KB) and rendered it as a heading with nothing under it, which
# reads as "the queue is empty". Detail beyond the budget is PULLED with
# swarm_read, the same pull-not-push rule CLAW-076 uses for mail.
swarm_dir = os.environ.get("OASIS_SWARM_DIR", "").strip()
try:
    swarm_max_bytes = int(os.environ.get("OASIS_SWARM_MAX_BYTES", "").strip() or "24576")
except ValueError:
    swarm_max_bytes = 24576
merge_config("dot-swarm", {
    "swarmDir": swarm_dir or str(home / ".openclaw/.swarm"),
    "registerSwarmReadTool": True,
    "maxBytes": swarm_max_bytes,
})
entries["dot-swarm"]["enabled"] = bool(swarm_dir)

# oasis-find (CLAW-082 phase 3): the search roots. Set EXPLICITLY per bot rather
# than defaulting to /reach, because /reach also contains /reach/mail — and
# grepping mail directly would return peer message text WITHOUT the
# nonce-delimited UNTRUSTED framing that reach_read applies. Peer text is a
# prompt-injection channel inside the trust boundary; it must arrive through the
# tool that labels it. Naming the work trees explicitly keeps mail out by
# construction instead of by a deny rule someone can weaken later.
#
# The plugin re-reads OASIS_FIND_ROOTS from process.env at register() and drops
# any path that is not a readable directory in THIS container, so a stale entry
# degrades to "not searched" rather than to a silent empty result set.
find_roots = [p.strip() for p in os.environ.get("OASIS_FIND_ROOTS", "").split(",") if p.strip()]
merge_config("oasis-find", {"roots": find_roots})
entries["oasis-find"]["config"]["roots"] = find_roots
entries["oasis-find"]["enabled"] = bool(find_roots)
# operating-system-sandbox (CLAW-043 gitignore read-shroud). BUNDLED into
# openclaw/dist/extensions at image build (NOT in the --link loop) so its
# tool-result middleware seam is honored — openclaw gates that seam to
# origin:"bundled". reachRoots + enforce are topology/env-driven (see
# TOPOLOGY_KEYS): a bot with reach mounts arms the shroud over them (Van Helsing
# sets OASIS_SHROUD_ROOTS=/reach/runes in its compose), while reach-less bots get
# just the always-shroud glob floor. OASIS_SHROUD_ENFORCE=0 => audit-only dry-run
# (record would-shroud events, let contents through) for validating the manifest
# before arming. The middleware itself logs loudly at boot if the seam is inert.
shroud_roots = [p.strip() for p in os.environ.get("OASIS_SHROUD_ROOTS", "").split(",") if p.strip()]
shroud_enforce = os.environ.get("OASIS_SHROUD_ENFORCE", "").strip().lower() not in ("0", "false", "no", "off")
merge_config("operating-system-sandbox", {
    "reachRoots": shroud_roots,
    "enforce": shroud_enforce,
    "auditPath": str(home / ".openclaw/logs/shroud-audit.jsonl"),
})
# compaction strategy — pin the swarm-compact provider. dot-swarm registers a
# CompactionProvider (id "swarm-compact") that, at the context ceiling, serves
# back the latest HANDOFF section the agent wrote into .swarm/state.md via the
# `compact` tool — instead of a generic summarizeInStages() summary. The
# provider is inert unless this key names it. Hard-set (like
# messages.tts.provider): a deliberate topology choice. If dot-swarm is ever
# removed, drop this key too, or the safeguard hook logs "configured but not
# registered". `compaction.mode` (e.g. "safeguard") is left untouched.
config.setdefault("agents", {})
config["agents"].setdefault("defaults", {})
config["agents"]["defaults"].setdefault("compaction", {})
# Only pin the provider when dot-swarm is actually enabled. A bot with no board
# (OASIS_SWARM_DIR empty) has dot-swarm disabled, and naming an unregistered
# provider makes the safeguard hook log "configured but not registered" forever.
if entries["dot-swarm"]["enabled"]:
    config["agents"]["defaults"]["compaction"]["provider"] = "swarm-compact"
elif config["agents"]["defaults"]["compaction"].get("provider") == "swarm-compact":
    del config["agents"]["defaults"]["compaction"]["provider"]

# compaction reserve — the headroom kept below the model window. The runtime's
# auto-compaction threshold is `contextWindow - reserveTokensFloor - softThreshold`
# (softThreshold defaults to 4000), and it keys off reserveTokensFloor, NOT the
# plain `reserveTokens` — which is itself floored UP to reserveTokensFloor
# (default 20000). So BOTH keys must be set or the 20000 floor wins and a bare
# reserveTokens=5000 is silently ignored. With 5000 the compaction line sits at
# window-9000. sleep-cycle's context-nap (preemptTokens=9000) fires just BEFORE
# that line, so a ballooned session gets a free archive+reset instead of paying
# native compaction — native compaction stays only as the ceiling safety-net.
try:
    _compaction_reserve = int(os.environ.get("OASIS_COMPACTION_RESERVE_TOKENS", "").strip() or "5000")
except ValueError:
    _compaction_reserve = 5000
_compaction_reserve = max(1000, _compaction_reserve)
config["agents"]["defaults"]["compaction"]["reserveTokens"] = _compaction_reserve
config["agents"]["defaults"]["compaction"]["reserveTokensFloor"] = _compaction_reserve

# ---- heartbeat cadence + active-hours (runtime efficiency) --------------
# openclaw's DEFAULT agent self-wakes every 30m (DEFAULT_HEARTBEAT_EVERY),
# and each wake reloads the FULL, growing session transcript and re-writes
# the prompt cache — with the short cache TTL it has expired between wakes,
# so every wake pays full cache-write price. On this fleet that heartbeat
# loop is the dominant cost driver (see AUDIT_LOG.md 2026-07-12 efficiency
# pass: ~97% of Nimbus's monthly spend was cache-write). We rein it in with
# env-driven defaults:
#   OASIS_HEARTBEAT_EVERY          duration, default unit minutes (e.g. "2h")
#   OASIS_HEARTBEAT_ACTIVE_START   "HH:MM" 24h — heartbeats fire only in-window
#   OASIS_HEARTBEAT_ACTIVE_END     "HH:MM" (or "24:00"); a daytime window == night sleep
#   OASIS_HEARTBEAT_ACTIVE_TZ      IANA tz / "user" / "local" (default America/New_York)
#   OASIS_HEARTBEAT_ISOLATED       "1" → run heartbeat in an isolated session (no transcript)
#   OASIS_HEARTBEAT_LIGHT_CONTEXT  "1" → bootstrap only HEARTBEAT.md
#   OASIS_HEARTBEAT_SKIP_WHEN_BUSY "1" → defer while subagent/cron lanes are busy
#
# activeHours gates ONLY the autonomous heartbeat (isWithinActiveHours in
# heartbeat-runner) — inbound Telegram replies are a separate path, so the
# bot still answers you at 3am. isolatedSession + lightContext are what
# collapse the cache-write cost: the heartbeat re-caches just HEARTBEAT.md
# instead of the whole transcript.
#
# setdefault semantics: these SEED the config, but a live
# `openclaw config set agents.defaults.heartbeat …` (hot-reloaded, no
# restart) overrides them and PERSISTS across reboots. The cheap-context
# fallbacks (isolated/light/skip + 2h) apply even when no env var is set,
# so a freshly-started persona bot never runs the wasteful 30m full-context
# loop. activeHours is only seeded when BOTH start+end are provided (a
# night-sleep window is a per-bot choice — set it in the bot's .env).
def _hb_envbool(name, default):
    v = os.environ.get(name)
    if v is None or v.strip() == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")

# Fleet-wide default: ~4 pulses/day (every 5h) inside a 06:30–22:30 ET active
# window, so every bot sleeps overnight (off-hours 22:30–06:30) unless its .env
# overrides. openclaw's heartbeat is interval+hash-phase (not clock-pinned), so
# these land ~5h apart in-window, not exactly on the hour.
hb = config["agents"]["defaults"].setdefault("heartbeat", {})
hb.setdefault("every", os.environ.get("OASIS_HEARTBEAT_EVERY", "").strip() or "5h")
hb.setdefault("isolatedSession", _hb_envbool("OASIS_HEARTBEAT_ISOLATED", True))
hb.setdefault("lightContext", _hb_envbool("OASIS_HEARTBEAT_LIGHT_CONTEXT", True))
hb.setdefault("skipWhenBusy", _hb_envbool("OASIS_HEARTBEAT_SKIP_WHEN_BUSY", True))
_hb_start = os.environ.get("OASIS_HEARTBEAT_ACTIVE_START", "").strip() or "06:30"
_hb_end = os.environ.get("OASIS_HEARTBEAT_ACTIVE_END", "").strip() or "22:30"
if _hb_start and _hb_end:
    _hb_active = hb.setdefault("activeHours", {})
    _hb_active.setdefault("start", _hb_start)
    _hb_active.setdefault("end", _hb_end)
    _hb_active.setdefault(
        "timezone",
        os.environ.get("OASIS_HEARTBEAT_ACTIVE_TZ", "").strip() or "America/New_York",
    )

# clawhub-skill-audit: Opus 4.7 security review on every newly installed skill,
# trail at ~/.openclaw/logs/skill-audits. ANTHROPIC_API_KEY and the Telegram
# creds are read by the plugin from env directly so we don't have to copy them
# into the JSON config (see the telegram-creds comment above).
# Quarantine + auditModel are intentionally not defaulted from the merge
# layer — change them by editing entries["clawhub-skill-audit"].config in
# openclaw.json directly when you want a non-default policy.
skill_audit_cfg = {
    "auditLogDir": str(home / ".openclaw/logs/skill-audits"),
    "skillsDirs": [
        str(home / ".openclaw/skills"),
        str(home / ".openclaw/workspace/skills"),
    ],
}
quarantine_dir = os.environ.get("OASIS_SKILL_AUDIT_QUARANTINE_DIR", "").strip() or None
if quarantine_dir:
    skill_audit_cfg["quarantineDir"] = quarantine_dir
merge_config("clawhub-skill-audit", skill_audit_cfg)

# model-switcher: agent tool + /setmodel slash command for hot-swapping the
# default LLM. No required config; allowedProviders is opt-in via env so a tight
# deployment can lock the agent to specific providers (defaults to unrestricted).
model_switcher_cfg: dict = {}
allowed_providers_env = os.environ.get("OASIS_MODEL_SWITCHER_ALLOWED_PROVIDERS", "").strip()
if allowed_providers_env:
    model_switcher_cfg["allowedProviders"] = [
        item.strip() for item in allowed_providers_env.split(",") if item.strip()
    ]
merge_config("model-switcher", model_switcher_cfg)

# memory-core: the agent's private long-term memory. It is a BUNDLED
# upstream plugin and the default `memory` slot (vendor/openclaw-source/
# src/plugins/slots.ts), so it already loads at startup and serves
# memory_search / memory_get + workspace/MEMORY.md with no config at all —
# it is NOT in the install --link loop above (that loop is for our 9
# /app/extensions plugins only).
#
# The one capability off by default is `dreaming`: the scheduled
# consolidation sweep that ranks recent recalls, promotes durable ones
# into MEMORY.md, and writes a Dream Diary. Without it, recall works but
# memory never consolidates — recent context is never made durable, which
# is the "agent forgets things" symptom. We enable it out of the box: a
# nightly 3 AM local light/REM/deep sweep. The plugin config schema
# (openclaw.plugin.json, additionalProperties:false) accepts ONLY the
# `dreaming` object. setdefault semantics — operators can retune frequency
# or disable via openclaw.json without the next boot stomping it.
merge_config("memory-core", {
    "dreaming": {
        "enabled": True,
        # Wind-down dream at 22:20 ET — right at the heartbeat sleep boundary
        # (activeHours ends 22:30), so the day's sessions consolidate into
        # MEMORY.md/DREAMS.md before overnight sleep (the "-> dream -> sleep"
        # step). Was 03:00; running bots are staggered a few min apart via
        # live config. setdefault — retune per bot without a boot stomping it.
        "frequency": "20 22 * * *",
        "timezone": "America/New_York",
    },
})

# sleep-cycle: cron-driven nightly session lifecycle (CLAW efficiency track).
# The plugin registers the `sleep_deep` TOOL (archive+reset the long-lived
# conversation session so its transcript stops growing — the prompt-cache
# cost fix) + a waking-summary supplement. The nightly TRIGGER is an openclaw
# cron (agentTurn -> sleep_deep) auto-installed by the banner-block below —
# openclaw does NOT run a plugin background timer, so cron is the driver. The
# dream step stays owned by memory-core's dreaming cron (22:20 above).
# `enabled` is FORCE-set from OASIS_SLEEP_ENABLED (not setdefault) so toggling
# the env var authoritatively flips it on recreate.
merge_config("sleep-cycle", {
    "timezone": os.environ.get("OASIS_SLEEP_TZ", "").strip() or "America/New_York",
})
entries["sleep-cycle"]["config"]["enabled"] = (
    (os.environ.get("OASIS_SLEEP_ENABLED", "").strip() or "1") == "1"
)

# context-nap: the CONTEXT-THRESHOLD deep-sleep. Same archive+reset+waking-
# summary cycle as the nightly deep-sleep, but triggered when a session's live
# prompt crosses `thresholdRatio` of the ACTIVE model's window — model-aware, so
# a small fallback model naps sooner than the big primary for the same work.
# `preemptTokens` MUST equal the compaction reserve + softThreshold (4000) so
# the nap fires just before native compaction would; we derive it from the same
# reserve set above to keep them locked together. setdefault semantics: operator
# overrides in a volume-persisted config are preserved; only unset keys are
# seeded. `enabled` is force-set from OASIS_CONTEXT_NAP_ENABLED (default on).
_nap_cfg = entries["sleep-cycle"]["config"].setdefault("contextNap", {})
_nap_cfg.setdefault("preemptTokens", _compaction_reserve + 4000)
try:
    _nap_ratio = float(os.environ.get("OASIS_CONTEXT_NAP_RATIO", "").strip() or "0.85")
except ValueError:
    _nap_ratio = 0.85
_nap_cfg.setdefault("thresholdRatio", max(0.1, min(0.99, _nap_ratio)))
_nap_cfg["enabled"] = (
    (os.environ.get("OASIS_CONTEXT_NAP_ENABLED", "").strip() or "1") == "1"
)

# ---- Layer 1: tools.profile from role.yaml (CLAW-047) --------------------
# When the role compiler runs, it exports OASIS_TOOLS_PROFILE (e.g. "coding").
# This overrides the profile on every boot so the running bot's tool surface
# matches its role manifest. Without a role.yaml the profile is whatever
# openclaw defaults to or whatever the operator set in openclaw.json.
tools_cfg = config.setdefault("tools", {})
role_profile = os.environ.get("OASIS_TOOLS_PROFILE", "").strip()
if role_profile:
    tools_cfg["profile"] = role_profile

# ---- web_fetch through the egress proxy (CLAW-073 / reach-parity) --------
# The bots run in an `internal:true` sandbox with NO DNS resolver — all egress
# goes through the fail-closed egress-proxy (HTTPS_PROXY=http://egress-proxy:3128).
# openclaw's web_fetch defaults to a STRICT policy that pre-resolves the hostname
# locally (getaddrinfo) for its SSRF check BEFORE connecting — which returns
# `EAI_AGAIN` in our resolver-less sandbox, so web_fetch was dead (only exec
# curl/wget, which delegate name resolution to the proxy CONNECT, worked).
# `tools.web.fetch.useTrustedEnvProxy=true` (added upstream, present in 7.1-2)
# switches web_fetch to trusted-env-proxy mode: it stops resolving DNS locally
# and routes through HTTPS_PROXY, letting the proxy do the DNS + allowlist
# gating. This does NOT broaden reach — the egress-proxy's allowlist is still the
# single control point (allowed host -> 200; denied host -> proxy refuses the
# CONNECT with reason=host-not-allowlisted, vettable=true). It only makes the
# native web_fetch tool usable and gives a clean policy-deny instead of a broken
# DNS error. Verified live on yesman 2026-07-26: anthropic.com->200,
# example.com->proxy-deny. Fleet-wide; VH included (still egress-narrowed).
web_cfg = tools_cfg.setdefault("web", {})
fetch_cfg = web_cfg.setdefault("fetch", {})
fetch_cfg["useTrustedEnvProxy"] = True

# ---- Layer 1: tools.alsoAllow (role.yaml seed + sleep-cycle toggle) ------
# Re-admit specific tools past the tools.profile filter. Role.yaml's
# `tools.alsoAllow` seeds the list (CLAW-047); the sleep-cycle enabled/disabled
# toggle still applies on top (sleep_deep is only useful when the plugin is
# active). Under a permissive profile (`full`) this is a harmless no-op.
also = tools_cfg.get("alsoAllow")
also = list(also) if isinstance(also, list) else []
# `also` is read from the PERSISTED, volume-mounted config, so a tool name
# added on a prior boot never goes away on its own — nothing below actively
# prunes an entry unless it is currently in one of the ADD/REMOVE tuples for an
# ENABLED feature. A retired tool with no owning tuple (e.g. reach_search,
# retired 2026-08-10) would sit in alsoAllow forever, allowlisting a tool that
# no longer exists. Harmless (verified live: no phantom tool appears, since the
# plugin simply never registers it) but is config drift worth not shipping.
RETIRED_TOOLS = ("reach_search",)
also = [x for x in also if x not in RETIRED_TOOLS]
role_also_allow = os.environ.get("OASIS_TOOLS_ALSO_ALLOW", "").strip()
if role_also_allow:
    for item in (x.strip() for x in role_also_allow.split(",") if x.strip()):
        if item not in also:
            also.append(item)
if entries["sleep-cycle"]["config"]["enabled"]:
    if "sleep_deep" not in also:
        also.append("sleep_deep")
else:
    also = [x for x in also if x != "sleep_deep"]
# oasis-reach (CLAW-076): re-admit the mail tools past the tools.profile filter,
# exactly like sleep_deep. The plugin registers reach_* via api.registerTool, but
# tools.profile="coding" drops unknown plugin tools unless they are allowlisted
# here — verified live 2026-08-03: House ran `reach_inbox` / `which reach_send` as
# SHELL commands (and hit the exec reviewer) because the tools were registered but
# not exposed. Gate on the same env the plugin's `enabled` uses.
# reach_search retired 2026-08-10 (CLAW-082 phase 4): its lexical ranking +
# optional LLM-synthesis pass is now redundant. Mail is indexed for
# memory_search (semantic recall, framed UNTRUSTED throughout — see
# claw-mail-corpus.mjs) and reachable by fs_grep/fs_glob at /reach/mail-corpus
# (exact-match, incl. its structured filters — grep "from: house" or a work-item
# id) for any bot with OASIS_FIND_ROOTS set. Two cheap general primitives beat
# one purpose-built tool with its own ranking code and a second model call.
REACH_TOOLS = ("reach_send", "reach_inbox", "reach_read", "reach_thread", "reach_help")
if os.environ.get("OASIS_REACH_ENABLE", "") == "1":
    for t in REACH_TOOLS:
        if t not in also:
            also.append(t)
else:
    also = [x for x in also if x not in REACH_TOOLS]

# ---- CLAW-082: the OTHER half of the CLAW-076 plugin-tool gotcha -----------
# contracts.tools in the manifest makes a registerTool'd tool MATERIALIZE.
# tools.profile="coding" then FILTERS it out again unless alsoAllow re-admits it.
# Both gates must pass. Verified live 2026-08-10: Kolmogorov's tool list held 33
# tools and none of swarm_read / compact / report_injection / forward_captcha /
# deposit_secret, although every one of them had shipped its manifest fix.
#
# swarm_read is read-only over the bot's own board — safe wherever a board exists.
SWARM_TOOLS = ("swarm_read",)
if swarm_dir:
    for t in SWARM_TOOLS:
        if t not in also:
            also.append(t)
else:
    also = [x for x in also if x not in SWARM_TOOLS]
#
# `compact` is DELIBERATELY NOT admitted here. It fs.appendFileSync's straight
# into <swarmDir>/state.md from inside the plugin, so it carries no derivedPaths
# and the oasis-reviewer's allowWriteRoots governance never sees it — the same
# blind spot oasis-reach has, but now aimed at a git-tracked board that several
# bots share. It would also grow the very state.md files whose size caused the
# starvation bug this ticket fixes. Governance decision first, then admit it.
#
# The three security tools Mike approved (2026-08-10). None was ever callable.
SECURITY_TOOLS = ("report_injection", "forward_captcha", "deposit_secret")
for t in SECURITY_TOOLS:
    if t not in also:
        also.append(t)

# ---- MEDIA OUT: the `tts` tool (2026-08-25, Mike: "all bots ... respond in kind") ----
# `tts` is a SPECIAL CASE in openclaw's catalog: tool-catalog.ts gives it
# `profiles: []` — it belongs to NO profile at all, so EVERY profile strips it,
# `coding` included. alsoAllow is the only route that admits it. That is why no
# bot could deliberately speak, on any profile, ever.
#
# This is distinct from `messages.tts.auto="inbound"`, which is already on and
# makes a bot reply with VOICE when the user sent VOICE. That is automatic and
# reactive. The tool is the deliberate route: the bot chooses to speak.
#
# It does NOT depend on the `message` tool. tts-tool.ts states "Audio
# auto-delivered from tool result" — the audio rides back on the tool result's
# details.media and the channel delivers it. So this is safe to admit fleet-wide
# without also handing out `message`, which is an exfiltration primitive and
# stays Nimbus-only.
#
# Synthesis is LOCAL (oasis-voice/Piper on the sandboxed net), so admitting this
# adds no egress and no cloud spend.
TTS_TOOLS = ("tts",)
if os.environ.get("OASIS_TTS_TOOL_DISABLE", "").strip() == "1":
    also = [x for x in also if x not in TTS_TOOLS]
    print("[entrypoint] tts tool: DISABLED (OASIS_TTS_TOOL_DISABLE=1)")
else:
    for t in TTS_TOOLS:
        if t not in also:
            also.append(t)

# ---- SELF-SERVICE VOICE (CLAW-107 phase 1) --------------------------------
# voice_list is read-only. voice_set changes only THIS bot's own speaking voice
# and cannot address another bot, so the blast radius is "how I sound" and
# nothing else. Both are admitted fleet-wide.
#
# voice_set writes ~/.openclaw/voice-choice.json, NOT openclaw.json. Rewriting
# openclaw.json under a live gateway kills the next turn with "config changed
# since last load"; the oasis-voice speech provider reads the side file per
# synthesis instead, so a change lands on the next spoken reply with no restart.
#
# NOTE the tool names must match extensions/oasis-voice-control/openclaw.plugin.json
# contracts.tools exactly — that manifest block makes them materialize, and this
# list re-admits them past tools.profile. BOTH gates are required (CLAW-082).
VOICE_CONTROL_TOOLS = ("voice_list", "voice_set")
if os.environ.get("OASIS_VOICE_CONTROL_DISABLE", "").strip() == "1":
    also = [x for x in also if x not in VOICE_CONTROL_TOOLS]
    print("[entrypoint] voice control tools: DISABLED (OASIS_VOICE_CONTROL_DISABLE=1)")
else:
    for t in VOICE_CONTROL_TOOLS:
        if t not in also:
            also.append(t)

# oasis-find (CLAW-082 phase 3). Read-only, root-confined, refuses secret-shaped
# files, and never sees /reach/mail. Gated on the same roots the plugin needs.
# deep_search (CLAW-092) joins the same gate: it is the same plugin, the same
# roots, and the same read-only confinement — it only adds a cross-encoder
# rerank over the passages fs_grep would already have returned.
FIND_TOOLS = ("fs_glob", "fs_grep", "fs_help", "deep_search")
if find_roots:
    for t in FIND_TOOLS:
        if t not in also:
            also.append(t)
else:
    also = [x for x in also if x not in FIND_TOOLS]
# ---- `message`: the outbound attachment tool (2026-08-24) ------------------
# The media audit found the fleet has no deliberate way to hand a file back to a
# human. `message` is the core tool that does it — it carries the attachments
# array that the whole generated-attachments path feeds. It sits in the
# "messaging" profile only (vendor/openclaw/src/agents/tool-catalog.ts:222-229),
# so tools.profile="coding" strips it on every bot. Live proof: every bot's
# tool-policy line reads "removed N tool(s) via tools.profile (coding): ...,
# message, ...".
#
# GATED, DEFAULT OFF, and deliberately NOT fleet-wide. `message` can send to
# arbitrary chats and carries arbitrary media, so it is an exfiltration primitive.
# The fleet's own rule is that privilege is inversely proportional to adversarial
# exposure (bots/yesman/role.yaml:16-17). House ingests market narratives and
# Kolmogorov ingests papers that argue for their own conclusions; neither should
# gain a send primitive to close out a media gap. Nimbus talks to Mike, holds the
# lowest injection exposure of the reach-enabled bots, and is the one bot whose
# reviewer runs constitutionalReviewRequired on EVERY call — so it is where this
# belongs first. Turn it on per-bot with OASIS_MESSAGE_TOOL_ENABLE=1.
#
# Pruned when the flag is unset, the same shape as FIND_TOOLS above, so turning
# the flag back off actually removes the tool instead of leaving it stranded in
# the persisted alsoAllow forever.
MESSAGE_TOOLS = ("message",)
if os.environ.get("OASIS_MESSAGE_TOOL_ENABLE", "").strip() == "1":
    for t in MESSAGE_TOOLS:
        if t not in also:
            also.append(t)
    print("[entrypoint] message tool: ENABLED (outbound attachments + media allowed)")
else:
    also = [x for x in also if x not in MESSAGE_TOOLS]

if also:
    tools_cfg["alsoAllow"] = also
elif "alsoAllow" in tools_cfg:
    del tools_cfg["alsoAllow"]

# session.reset — the ACTUAL deep-sleep reset, done the framework's way.
# openclaw natively resets a long-lived conversation session on a schedule
# (mode "daily", at `atHour` local): it archives the transcript to
# `<file>.reset.<ts>` and starts a fresh session — the prompt-cache cost fix —
# with NO cron, NO agent tool, and NO operator.admin scope. That last point is
# why a fresh headless bot can do this at all: the CLI `cron add` /
# `sessions.reset` path is gated behind operator.admin the bot can't self-grant,
# but the native reset runs in-process on openclaw's own schedule. sleep-cycle's
# `before_reset` hook rides this reset to stage the waking summary.
#
# We set the BASE `session.reset` (not resetByType.direct) so it covers the main
# session too — the default `dmScope` is "main", so Telegram DMs run IN the main
# session, and a per-type "direct" rule would miss them.
#
# atHour = the daily "day boundary": a session is stale (→ reset on its next
# message) once it started before today's atHour. Default 23 (11 PM): the day's
# context is held through all waking hours and rolls over at night, right after
# the 22:20 memory-core dream (so the day is CONSOLIDATED before it's archived —
# the boundary must sit AFTER the dream, and hourly granularity makes 23 the
# tightest slot after a 22:20 dream; do not drop it to 22). NOTE the reset is
# LAZY — it fires on the first message after the boundary, so an
# inactive-overnight bot effectively resets at its first morning message; the
# end state (fresh session + injected handoff) is identical either way. A truly
# proactive wall-clock reset would need the manual `sleep_deep` tool on a cron
# (operator.admin). Force-set from OASIS_SESSION_RESET_HOUR; only while
# sleep-cycle is enabled (its hook is what makes the reset carry continuity).
if entries["sleep-cycle"]["config"]["enabled"]:
    try:
        _reset_hour = int(os.environ.get("OASIS_SESSION_RESET_HOUR", "").strip() or "23")
    except ValueError:
        _reset_hour = 23
    _reset_hour = max(0, min(23, _reset_hour))
    session_cfg = config.setdefault("session", {})
    session_cfg["reset"] = {"mode": "daily", "atHour": _reset_hour}
    # Drop any legacy per-type "direct" seed from older images so the base
    # policy is authoritative (avoids two rules disagreeing).
    _rbt = session_cfg.get("resetByType")
    if isinstance(_rbt, dict):
        _rbt.pop("direct", None)
        if not _rbt:
            session_cfg.pop("resetByType", None)

# oasis-semantics: local-first embedding provider for memory-core, backed by
# the oasis-semantics sidecar (sentence-transformers text + CLIP/SigLIP
# multimodal). Same loader gotcha as oasis-voice: no `contracts` block in
# the manifest, so oasis-semantics is invisible to memory-core's auto-select
# priority registry. We HARD-PIN it as the default embedding provider here,
# same pattern as the `messages.tts.provider` pin for oasis-voice.
#
# The initial tier choice is load-bearing — switching embedding models
# invalidates every stored vector and forces a full re-embed of the memory
# store. "default" = BAAI/bge-small-en-v1.5 (384-d, MIT, English-only).
# To change: update the model key below AND run the re-embed migration.
oasis_semantics_endpoint = (
    os.environ.get("OASIS_SEMANTICS_ENDPOINT", "").strip()
    or "http://oasis-semantics:8732"
)
oasis_semantics_bearer = os.environ.get("OASIS_SEMANTICS_BEARER_TOKEN", "").strip() or None
oasis_semantics_text_model = (
    os.environ.get("OASIS_SEMANTICS_TEXT_MODEL", "").strip() or "default"
)
oasis_semantics_mm_model = (
    os.environ.get("OASIS_SEMANTICS_MM_MODEL", "").strip() or "clip-lite"
)
oasis_semantics_cfg: dict = {
    "endpoint": oasis_semantics_endpoint,
    "default_text_model": oasis_semantics_text_model,
    "default_mm_model": oasis_semantics_mm_model,
}
if oasis_semantics_bearer:
    oasis_semantics_cfg["bearer_token"] = oasis_semantics_bearer
merge_config("oasis-semantics", oasis_semantics_cfg)

# Pin memory-core to use oasis-semantics as the embedding provider.
# Without this, provider defaults to "auto" which iterates by
# autoSelectPriority — and oasis-semantics has none (same reason as
# oasis-voice: no contracts block = invisible to auto-select).
# Hard-overwrite on every boot so the pin survives config edits.
config["agents"]["defaults"].setdefault("memorySearch", {})
config["agents"]["defaults"]["memorySearch"]["provider"] = "oasis-semantics"
config["agents"]["defaults"]["memorySearch"]["model"] = oasis_semantics_text_model

# ── CLAW-082 phase 1: index session transcripts, and let a bot SEE its own ──
#
# Two separate switches are needed. Setting only the first indexes transcripts
# that the agent then cannot retrieve, which is what we measured on Nimbus.
#
# 1. memorySearch.sources + experimental.sessionMemory. DEFAULT_SOURCES is
#    ["memory"] and experimental.sessionMemory defaults FALSE
#    (memory-search.ts:132, :174, :221), and "sessions" is DROPPED from sources
#    unless that flag is true. Before this, every bot reported `Sources: memory`
#    and its whole semantic index was MEMORY.md plus dream prose — 669 dream
#    artifacts against 18 real memory notes fleet-wide.
#
# 2. tools.sessions.visibility. resolveSessionToolsVisibility defaults to "tree"
#    (session-visibility.ts:77-85), so memory_search hits from any session
#    outside the requester's own tree are filtered out before the agent sees
#    them. Measured on Nimbus: the CLI found the Roxborough seller-credit
#    discrepancy at score 0.790 while the AGENT answered "no genuine memory of
#    this exists". "agent" scopes recall to the bot's OWN sessions; it does NOT
#    cross the agent boundary the way "all" would, so the nimbus/helloworld
#    partition is unaffected.
#
# SANDBOX CLAMP: resolveEffectiveSessionToolsVisibility forces "tree" back on a
# sandboxed agent unless agents.defaults.sandbox.sessionToolsVisibility is "all"
# (session-visibility.ts:88-101). We set that too, so the setting means the same
# thing on every bot instead of silently degrading on some.
#
# KNOWN WIDENING, accepted deliberately: a transcript that captured a secret
# becomes searchable through memory_search. The reviewer's denyReadGlobs stops
# secret FILE reads, not recall of a conversation the bot already had — and
# sessions_history already exposed the same bytes. Set OASIS_SESSION_MEMORY=0
# per bot to opt out.
#
# COST measured on Nimbus, the largest corpus in the fleet: 293 session files /
# 24.5 MB indexed in ~10 min on the CPU sidecar, 1,258 -> 2,485 chunks. The
# 271 MB of *.trajectory.jsonl is NOT indexed — the corpus enumerator walks
# <sessionId>.jsonl only (session-transcript-corpus.ts:281).
if (os.environ.get("OASIS_SESSION_MEMORY", "").strip() or "1") == "1":
    _ms = config["agents"]["defaults"]["memorySearch"]
    _ms["sources"] = ["memory", "sessions"]
    _ms.setdefault("experimental", {})["sessionMemory"] = True
    tools_cfg.setdefault("sessions", {})["visibility"] = "agent"
    config["agents"]["defaults"].setdefault("sandbox", {})["sessionToolsVisibility"] = "all"

# ── CLAW-082 phase 2: .swarm project boards as a memory-search corpus ──────
#
# memorySearch.extraPaths adds directories to the index. It is CONFIG ONLY — no
# upstream change, no plugin. But it is blunt, and the bluntness decides the
# whole design (host/internal.ts:92-215):
#   * a directory is walked RECURSIVELY and every .md under it is taken;
#   * there is NO exclude, NO ignore list, NO glob;
#   * SYMLINKS ARE SKIPPED, so a curated symlink farm indexes nothing.
# So the path list has to be exact. Pointing at a repo root is a trap: the
# oasis-x tree holds 35,373 .md files / 167 MB (21,836 of them under
# oasis-hardware/"External Reference Repos", 1,979 under oasis-claw/vendor),
# which is ~105,000 chunks plus a 35,000-entry chokidar watcher. Upstream warns
# above 2,000 watched entries (watch-pressure.ts:4).
#
# Rather than hand-maintain a per-bot path list that silently rots when a new
# project gets a board, we DERIVE it: scan the roots the bot actually mounts and
# take the directories literally named `.swarm`. A new project board joins the
# corpus on the next recreate; a deleted one drops out. Same derive-don't-repeat
# rule as the reach volumes.
#
# EXCLUDES are load-bearing, not hygiene. `.claude/worktrees` in particular
# holds two 69-file NEAR-COPIES of oasis-x/.swarm — indexing them puts three
# slightly different versions of the same brief in the index, which is the
# stale-brief failure at scale.
SWARM_CORPUS_EXCLUDE = (
    "node_modules", ".git", ".venv", "venv", "vendor", "forks", "worktrees",
    ".claude", "External Reference Repos", "dist", "build", ".next", "__pycache__",
)
SWARM_CORPUS_MAX_DIRS = 200
SWARM_CORPUS_MAX_DEPTH = 6


def _discover_swarm_dirs(roots):
    found = []
    for root in roots:
        root = root.strip()
        if not root or not os.path.isdir(root):
            continue
        # A root may itself BE the board (House mounts oasis-x/.swarm directly
        # at /reach/oasis-swarm, so the directory is not named `.swarm`).
        if os.path.isdir(root) and (
            os.path.basename(root) == ".swarm"
            or os.path.isfile(os.path.join(root, "queue.md"))
            or os.path.isfile(os.path.join(root, "state.md"))
        ):
            found.append(os.path.realpath(root))
            continue
        base_depth = root.rstrip("/").count("/")
        for dirpath, dirnames, _files in os.walk(root, followlinks=False):
            if dirpath.rstrip("/").count("/") - base_depth >= SWARM_CORPUS_MAX_DEPTH:
                dirnames[:] = []
                continue
            dirnames[:] = [d for d in dirnames if d not in SWARM_CORPUS_EXCLUDE]
            if ".swarm" in dirnames:
                found.append(os.path.realpath(os.path.join(dirpath, ".swarm")))
                # Do NOT descend into it; it has no nested boards.
                dirnames.remove(".swarm")
    return found


_corpus_roots = [p for p in os.environ.get("OASIS_MEMORY_SWARM_ROOTS", "").split(",") if p.strip()]
_literal_paths = [p.strip() for p in os.environ.get("OASIS_MEMORY_EXTRA_PATHS", "").split(",") if p.strip()]
if _corpus_roots or _literal_paths:
    _paths = _discover_swarm_dirs(_corpus_roots) + [
        os.path.realpath(p) for p in _literal_paths if os.path.isdir(p) or os.path.isfile(p)
    ]
    # Deterministic order: the prompt cache keys off the config bytes.
    _paths = sorted(dict.fromkeys(_paths))
    if len(_paths) > SWARM_CORPUS_MAX_DIRS:
        print(
            f"[entrypoint] WARN: .swarm corpus found {len(_paths)} dirs, capping at "
            f"{SWARM_CORPUS_MAX_DIRS} — DROPPED: {_paths[SWARM_CORPUS_MAX_DIRS:]}",
            file=sys.stderr,
        )
        _paths = _paths[:SWARM_CORPUS_MAX_DIRS]
    _md = 0
    for _p in _paths:
        for _dp, _dn, _fn in os.walk(_p, followlinks=False):
            _md += sum(1 for f in _fn if f.endswith(".md"))
    print(f"[entrypoint] memory corpus: {len(_paths)} paths, {_md} markdown files")
    config["agents"]["defaults"]["memorySearch"]["extraPaths"] = _paths
elif "extraPaths" in config["agents"]["defaults"]["memorySearch"]:
    del config["agents"]["defaults"]["memorySearch"]["extraPaths"]

# MMR (maximal marginal relevance) — DEFAULT IS OFF (memory-search.ts:127).
# Turn it on. Without it a query returns near-duplicate chunks from one cluster:
# the query that opened CLAW-082 returned five hits at 0.609 that were all the
# same dream-diary material, and a Nimbus query returned three of four hits from
# a SINGLE session file. Six results from six places is worth more than six
# views of one place, which is the whole point of a cross-project corpus.
# lambda 0.7 keeps relevance dominant over diversity.
#
# NOT enabled: query.hybrid.temporalDecay. It also defaults off, and it is the
# wrong tool here — it multiplies the score by exp(-ln2/halfLife * ageDays)
# (temporal-decay.ts:36-42), so with the default 30-day half life and
# minScore 0.35 a 90-day-old brief scores 0.75 -> 0.09 and disappears. Mike
# asked for the .swarm archive to stay reachable (2026-08-10); decay would bury
# it. Left off deliberately.
_hyb = config["agents"]["defaults"]["memorySearch"].setdefault("query", {}).setdefault("hybrid", {})
_hyb.setdefault("mmr", {})["enabled"] = True
_hyb["mmr"].setdefault("lambda", 0.7)

# oasis-voice: speech (TTS) + media-understanding audio (inbound voice
# messages from Telegram / iMessage) + realtime streaming STT (for future
# telephony / WebRTC) backed by the oasis-voice sidecar.
#
# Default endpoint is the docker-compose service name `oasis-voice:8731`
# (sibling container on the oasis_runtime bridge network — see
# docker-compose.runtime.yml). Falls back to 127.0.0.1:8731 if someone is
# running the gateway directly on a host with oasis-voice in a venv (dev
# convenience only; production always uses the sidecar).
#
# Cloud/GPU tiers (CLAW-013): set OASIS_VOICE_ENDPOINT to the hosted URL
# and OASIS_VOICE_BEARER_TOKEN to the auth token, both in `.env`.
oasis_voice_endpoint = (
    os.environ.get("OASIS_VOICE_ENDPOINT", "").strip()
    or "http://oasis-voice:8731"
)
oasis_voice_bearer = os.environ.get("OASIS_VOICE_BEARER_TOKEN", "").strip() or None
oasis_voice_tts_voice_env = os.environ.get("OASIS_VOICE_TTS_VOICE", "").strip()
oasis_voice_tts_voice = oasis_voice_tts_voice_env or "piper:en_GB-aru-medium"
oasis_voice_cfg: dict = {
    "endpoint": oasis_voice_endpoint,
    "tts_voice": oasis_voice_tts_voice,
}
if oasis_voice_bearer:
    oasis_voice_cfg["bearer_token"] = oasis_voice_bearer
merge_config("oasis-voice", oasis_voice_cfg)
# When the operator explicitly sets OASIS_VOICE_TTS_VOICE in .env, that's an
# override of any previously-persisted plugin config — the setdefault path in
# merge_config would otherwise leave a stale voice from an earlier boot
# pinned forever. Force-overwrite only when the env var is explicitly set.
if oasis_voice_tts_voice_env:
    entries["oasis-voice"]["config"]["tts_voice"] = oasis_voice_tts_voice_env

# ---- audio media-understanding routing (CLAW-021) ----------------------
# Telegram (and future iMessage) voice-message inbound: when a user sends
# a voice note, openclaw's media-understanding pipeline picks an audio
# provider to transcribe it. The valid config schema for this section is
# enumerated in vendor/openclaw-source/src/config/media-audio-field-metadata.ts
# — `tools.media.audio.provider` is NOT a valid key (which caused a config
# validation failure on the first boot of d081484); the ordered fallback
# list `tools.media.audio.models` IS the valid route.
#
# We HARD-PIN oasis-voice first here. autoPriority cannot be relied on:
# oasis-voice deliberately ships WITHOUT a manifest `contracts` block (see
# extensions/oasis-voice/openclaw.plugin.json _contracts_NOTE — declaring
# contracts breaks eager-load for this /app/extensions/-mounted plugin),
# and media-understanding's autoPriority registry only contains providers
# that DO declare contracts. So oasis-voice is invisible to autoPriority
# and inbound audio silently falls through to the cloud providers
# (openai/google). An explicit `tools.media.audio.models` pin is the only
# route that makes the media-understanding runner attempt oasis-voice's
# (runtime-registered) provider first.
#
# The list is STRICT LOCAL-ONLY as of 2026-08-24: oasis-voice (local Moonshine)
# and nothing else. It used to carry an openai/gpt-4o-transcribe second entry
# described as a cloud degradation path; that entry could never fire and the
# claim was false — see the block immediately below the assignment for the three
# independent reasons. This is the inbound counterpart of the
# `messages.tts.provider` outbound pin below, and is hard-overwritten on
# every boot for the same reason that pin is. Both pins are asserted at the end
# of this script so neither can silently rot.
config.setdefault("tools", {})
config["tools"].setdefault("media", {})
config["tools"]["media"].setdefault("audio", {})
config["tools"]["media"]["audio"]["enabled"] = True

# ---- VIDEO media-understanding (2026-08-25, item 4) -----------------------
# Inbound video had NO route at all: tools.media held only `audio`, and the
# native-vision skip in media-understanding/runner.ts is coded for
# `capability === "image"` alone, so video got no equivalent free pass.
#
# The capability exists and is real. openclaw's bundled `google` extension
# declares capabilities ["image","audio","video"] and implements describeVideo
# (dist/extensions/google/media-understanding-provider.js). The plugin is loaded
# on all 7 bots.
#
# REACH is the constraint, not capability. Measured 2026-08-25 against
# generativelanguage.googleapis.com:
#   nimbus, hello-world      -> HTTP 403 (reached the API, unauthenticated)
#   the 5 sandboxed bots     -> HTTP 000 (blocked at the egress proxy)
# So this is OPT-IN per bot. Enabling it on a sandboxed bot without first adding
# the Google API origin to that bot's egress allowlist would just produce a
# slower failure, not video support.
#
# NOTE this key is capability-scoped and does NOT disturb images:
# runner.ts binds `cfg.tools.media[capability]`, so tools.media.video is read
# only on the video path. See the image block below for why that matters.
if os.environ.get("OASIS_MEDIA_VIDEO_ENABLE", "").strip() == "1":
    _video_model = os.environ.get("OASIS_MEDIA_VIDEO_MODEL", "").strip() or "gemini-3.1-flash-lite"
    config["tools"]["media"].setdefault("video", {})
    config["tools"]["media"]["video"]["enabled"] = True
    config["tools"]["media"]["video"]["models"] = [
        {"provider": "google", "model": _video_model},
    ]
    print(f"[entrypoint] media video: ENABLED via google/{_video_model}")
else:
    # Leave the key ABSENT rather than enabled-false: an absent capability is
    # the documented "no route" state, and a stale key from an earlier boot
    # would otherwise pin a provider this bot cannot reach.
    config["tools"]["media"].pop("video", None)
    print("[entrypoint] media video: no route (set OASIS_MEDIA_VIDEO_ENABLE=1 on a bot that can reach the provider)")
# 2026-08-24: the openai/gpt-4o-transcribe fallback was REMOVED. It could never
# fire, for three independent reasons found in the media audit:
#   1. No bot has an `openai` block under models.providers, so the provider-auth
#      resolver has nothing to resolve.
#   2. The five sandboxed bots cannot reach api.openai.com at all — the egress
#      allowlist is .anthropic.com + api.telegram.org plus per-bot seeds, and no
#      bot's seed or learned list names an OpenAI host.
#   3. The shared OpenAI key has no quota. Two persisted error bodies prove it:
#      /home/node/.openclaw/media/inbound/file_3---872b4d69-*.txt and
#      file_5---454367bc-*.txt each contain "type": "insufficient_quota".
# A fallback that cannot fire is worse than no fallback: the comment above used
# to promise that a sidecar outage "degrades to cloud rather than failing", and
# that promise was false. Transcription is local-only. If the sidecar is down,
# inbound voice fails loudly — which is the honest behaviour. To restore a real
# fallback, add a models.providers entry, an egress origin, and a funded key.
config["tools"]["media"]["audio"]["models"] = [
    {"provider": "oasis-voice", "model": "moonshine-base"},
]
# Strip stale `provider` key from prior boots — that key isn't valid in
# the audio-config schema. Idempotent merge alone wouldn't clean up a
# once-broken config file on the persistent volume.
config["tools"]["media"]["audio"].pop("provider", None)

# Provider baseUrl + apiKey hand-off. The openclaw
# MediaUnderstandingProvider framework reads these from
# `models.providers.<id>` and passes them to our `transcribeAudio`
# callback. Without them, the plugin falls back to its DEFAULT_ENDPOINT
# (http://127.0.0.1:8731) which is wrong inside the openclaw container
# (no sidecar at loopback); the docker-DNS name we set above is the
# right value.
#
# zod-schema.core.ts:352 declares ModelProviderSchema as strict with
# `models: z.array(ModelDefinitionSchema)` REQUIRED — even when the
# provider doesn't offer LLM models (we're a media-understanding-only
# provider, not a chat model provider). Pass an empty array to satisfy
# the schema; the framework only consults this list for chat-model
# selection, which is irrelevant for our STT capability.
config.setdefault("models", {})
config["models"].setdefault("providers", {})
config["models"]["providers"].setdefault("oasis-voice", {})
config["models"]["providers"]["oasis-voice"]["baseUrl"] = oasis_voice_endpoint
config["models"]["providers"]["oasis-voice"].setdefault("models", [])
# apiKey is REQUIRED for the media-understanding pipeline to route here:
# its provider-auth resolver hard-fails ("No API key found for provider
# oasis-voice") before ever calling transcribeAudio if the key is absent,
# even though the local lite tier needs no credentials. The plugin's
# transcribe path treats the literal "anonymous" as "send no Authorization
# header" (media-understanding-provider.ts buildAuthHeaders), so we seed
# that sentinel for the local tier. A real bearer (hosted/GPU tier, CLAW-013)
# overrides it. Hard-overwrite, not setdefault: a stale "anonymous" left by a
# prior boot must yield to a bearer added later via .env, and vice versa.
config["models"]["providers"]["oasis-voice"]["apiKey"] = (
    oasis_voice_bearer if oasis_voice_bearer else "anonymous"
)

# ---- media retention (2026-08-24) --------------------------------------
# Nothing has EVER been pruned from any bot's media tree. The cause is a single
# unset key: vendor/openclaw/src/gateway/server-maintenance.ts:345-353 returns
# `mediaCleanup: null` when mediaCleanupTtlMs is not a number, and `cfg.media`
# was unset on all 7 bots — so the cleanup timer was never installed at all.
# Evidence at audit time: Nimbus's oldest inbound file dated 2026-05-04, and
# every sticker ever received is downloaded and kept (the description cache is
# bypassed whenever the model has vision, which is always on this fleet).
#
# ttlHours is an int bounded [1, 168] by zod-schema.ts:906-911, so 168 (7 days)
# is the MAXIMUM the schema allows and the most conservative setting that still
# turns cleanup on. Cleanup walks the full media tree recursively and prunes
# empty dirs, so it removes BOTH inbound and outbound media past the window.
# Override per-bot with OASIS_MEDIA_TTL_HOURS; set it to 0 to opt out entirely
# and keep the old never-prune behaviour.
_media_ttl_raw = os.environ.get("OASIS_MEDIA_TTL_HOURS", "").strip()
try:
    _media_ttl = int(_media_ttl_raw) if _media_ttl_raw else 168
except ValueError:
    print(f"[entrypoint] media retention: OASIS_MEDIA_TTL_HOURS={_media_ttl_raw!r} "
          f"is not an integer — falling back to 168")
    _media_ttl = 168
if _media_ttl > 0:
    _media_ttl = max(1, min(_media_ttl, 168))
    config.setdefault("media", {})["ttlHours"] = _media_ttl
    print(f"[entrypoint] media retention: {_media_ttl}h (cleanup timer INSTALLED)")
else:
    config.get("media", {}).pop("ttlHours", None)
    if config.get("media") == {}:
        config.pop("media", None)
    print("[entrypoint] media retention: disabled (media is never pruned)")

# ---- outbound voice (CLAW-021): voice-in → voice-out ------------------
# Three knobs together make this work:
#   1. `messages.tts.provider = "oasis-voice"` — when openclaw decides to
#      TTS a reply, it asks our SpeechProvider (not deepgram/elevenlabs/
#      anything else that may register later). This is the OUTBOUND
#      counterpart of the inbound `tools.media.audio.models` pin above.
#   2. `messages.tts.auto = "inbound"` — only TTS the reply when the
#      INBOUND message was itself audio. Text-in → text-out (cheap path).
#      Voice-note-in → voice-note-out (Nimbus speaks back). Other modes:
#      "off" (never), "always" (every reply), "tagged" (a /tts toggle).
#      "inbound" is the right default for the MVP — matches conversational
#      cadence and doesn't spend Piper cycles on text-only chats.
#   3. The plugin's SpeechProvider already requests `?format=opus` when
#      the framework asks for a voice-note shape, so Telegram's sendVoice
#      gets the right container. See speech-provider.ts.
config.setdefault("messages", {})
config["messages"].setdefault("tts", {})
config["messages"]["tts"]["provider"] = "oasis-voice"
# Don't overwrite an operator's explicit `auto` setting — only seed the
# default if absent. If someone runs `openclaw config set messages.tts.auto
# always`, we respect that on the next boot.
config["messages"]["tts"].setdefault("auto", "inbound")
# Provider config for the TTS framework. speech-core resolves provider config
# from `messages.tts.providers.<id>`, NOT from `plugins.entries.<id>.config`.
# Without this block, synthesize() receives an empty providerConfig, the
# speech-provider falls back to DEFAULT_ENDPOINT (http://127.0.0.1:8731) which
# is wrong inside the container (no sidecar at loopback), the request fails,
# and the framework silently falls through to a cloud TTS provider. This is
# the bug that caused "US Female default" voice instead of the configured UK voice.
config["messages"]["tts"].setdefault("providers", {})
config["messages"]["tts"]["providers"]["oasis-voice"] = {
    "endpoint": oasis_voice_endpoint,
    "tts_voice": oasis_voice_tts_voice,
    "apiKey": oasis_voice_bearer if oasis_voice_bearer else "anonymous",
}
if oasis_voice_bearer:
    config["messages"]["tts"]["providers"]["oasis-voice"]["bearer_token"] = oasis_voice_bearer

# browser: vendored openclaw `browser` plugin (extensions/browser/).
# Manifest declares `onConfigPaths: ["browser"]`, so this plugin reads its
# runtime config from the TOP-LEVEL `browser` key in openclaw.json — NOT
# from `plugins.entries.browser.config`. The merge_config() call above
# only flips `enabled: true` on the entry; the actual plugin config is
# written below.
#
# The single load-bearing setting is `browser.evaluateEnabled = false`.
# The CLAW-014 evaluate-slice audit confirmed in source that
# `DEFAULT_BROWSER_EVALUATE_ENABLED = true` upstream
# (extensions/browser/src/browser/constants.ts), and that the gates at
# pw-tools-core.interactions.ts:1367/1385 honor `evaluateEnabled` to
# block both `act:evaluate` and `wait --fn`. Without this override, an
# agent could `evaluate()` arbitrary JS in pages by default — the worst-
# case mode of the plugin. Per-session opt-in to evaluate would be a
# follow-on (CLAW-015) and must come with a mandatory JSONL audit log
# + Playwright trace.
#
# We also pin browser-side data dirs under the persistent volume so
# profile/cookie data survives image rebuilds; binaries themselves live
# at /opt/playwright (set in Dockerfile.runtime) which is read-only and
# image-baked.
merge_config("browser", {})  # entries.browser.enabled = true
config.setdefault("browser", {})
config["browser"]["enabled"] = True
# The override. Do NOT remove without re-running the evaluate-slice audit
# and writing CLAW-015's per-session opt-in + audit-log patches first.
config["browser"]["evaluateEnabled"] = False
# Persistent profile data — the browser plugin handles its own user-data
# directory routing through `profiles` (BrowserProfileConfig). The top-
# level `BrowserConfig` type has no `dataDir` key; an earlier cut wrote
# one here and the strict-schema validator (zod-schema.core.ts) rejected
# the whole `browser` block. Profile-level configuration is left to the
# plugin's own defaults for now; if we need to override the user-data dir
# we'd add a `profiles` map below per types.browser.ts:81.
# Strip any stale `dataDir` from prior boots so the config stops failing
# validation on the persisted file.
config["browser"].pop("dataDir", None)

# ---- default LLM model (OPENCLAW_DEFAULT_MODEL env var) ----------------
# Set via .env + make recreate, or live from chat via /setmodel (model-switcher,
# which writes agents.defaults.model.primary through replaceConfigFile).
# Provider strings: "oasis-generation/claude-sonnet-5", "anthropic/claude-sonnet-4-6",
#   "google/gemini-3.1-flash-lite", "openai/gpt-4o", "ollama/llama3.3".
#
# PRECEDENCE (CLAW-113). Until 2026-08-25 this block was "env always wins": every
# boot overwrote primary with OPENCLAW_DEFAULT_MODEL. Restarts are frequent (the
# config-audit log shows 5 on 2026-08-25 alone), so a /setmodel made from Telegram
# survived only until the next restart and the bot silently fell back to the .env
# model. That is the reversion Mike reported, and on Nimbus it is what kept the
# fleet on direct Anthropic instead of the oasis-generation gateway.
#
# The rule now is SEED-ONCE, CHAT-WINS, with .env changes still propagating. A
# side file records the value this entrypoint last seeded — the same side-file
# pattern oasis-voice uses for the selected voice, and for the same reason: the
# marker must NOT go into openclaw.json, whose strict zod schema rejects unknown
# keys. Cases:
#   1. no marker file        -> unmanaged/migrating bot: seed from env, write marker.
#   2. primary == marker     -> nobody changed it from chat: adopt the current env
#                               value (so editing .env still rotates the fleet).
#   3. primary != marker     -> a human changed it from chat: LEAVE IT ALONE.
#   4. OPENCLAW_DEFAULT_MODEL_FORCE=1 -> always take env (break-glass rollback).
# Marker lives beside openclaw.json in the bot's persistent volume.
default_model = os.environ.get("OPENCLAW_DEFAULT_MODEL", "").strip() or None
force_default = os.environ.get("OPENCLAW_DEFAULT_MODEL_FORCE", "").strip() in ("1", "true", "yes")
config.setdefault("agents", {})
config["agents"].setdefault("defaults", {})
config["agents"]["defaults"].setdefault("model", {})
existing_primary = config["agents"]["defaults"]["model"].get("primary")

_seed_path = config_path.parent / "oasis-model-seed.json"
try:
    _seed_state = json.loads(_seed_path.read_text())
    if not isinstance(_seed_state, dict):
        _seed_state = {}
except Exception:
    _seed_state = {}
_seeded_primary = _seed_state.get("primary")


def _write_seed_marker(**fields) -> None:
    """Persist what this entrypoint seeded, so the next boot can tell an
    operator .env rotation apart from a /setmodel made in chat."""
    _seed_state.update(fields)
    try:
        _seed_path.write_text(json.dumps(_seed_state, indent=2) + "\n")
    except Exception as exc:  # non-fatal: degrades to "env wins", never blocks boot
        print(f"[entrypoint] WARN: could not write {_seed_path.name}: {exc}")


if default_model:
    if force_default:
        _reason = "OPENCLAW_DEFAULT_MODEL_FORCE=1"
    elif _seeded_primary is None:
        _reason = "no seed marker (first managed boot)"
    elif existing_primary == _seeded_primary:
        _reason = "primary still matches the last seeded value"
    else:
        _reason = None

    if _reason is not None:
        config["agents"]["defaults"]["model"]["primary"] = default_model
        _write_seed_marker(primary=default_model)
        print(f"[entrypoint] default model set to: {default_model} ({_reason})")
    else:
        print(
            f"[entrypoint] default model KEPT as {existing_primary} — changed from chat "
            f"(last seeded {_seeded_primary!r}); .env asks for {default_model!r}. "
            f"Set OPENCLAW_DEFAULT_MODEL_FORCE=1 to override."
        )
elif not existing_primary:
    # No env override and nothing already configured (fresh fleet bot): default
    # to the oasis-generation gateway instead of falling through to openclaw's
    # openai/gpt-5.5 built-in, which needs an OpenAI key no bot has. Routing the
    # default through the gateway keeps inference on Bedrock (billed to the AWS
    # account) rather than direct-Anthropic credits. Override via .env.
    fallback_model = "oasis-generation/claude-sonnet-5"
    config["agents"]["defaults"]["model"]["primary"] = fallback_model
    _write_seed_marker(primary=fallback_model)
    print(f"[entrypoint] no OPENCLAW_DEFAULT_MODEL set; defaulting to {fallback_model}")

# ---- agent identity: name / emoji (CLAW-057) ---------------------------
# Sets the agent's DISPLAY IDENTITY. Until 2026-07-20 this was unset fleet-wide,
# so `resolveMessagePrefix` fell through to its built-in "[openclaw]" fallback
# and every bot signed its outbound messages with the product name instead of
# its own. That is the config gap behind the Yes Man identity incident.
#
# WHERE THIS LANDS (verified against the 6.11 dist, not the 4.26 vendor tree):
#   resolveAgentIdentity()  = resolveAgentConfig(cfg, agentId)?.identity
#   resolveAgentEntry()     = cfg.agents.list.find(e => e.id === agentId)
# so the identity MUST live in `agents.list[]` keyed by agent id — NOT in
# `agents.defaults`, which resolveAgentConfig never consults for `identity`.
# With no matching list entry, resolveAgentConfig returns undefined and the
# name silently falls back. Every bot in this fleet runs the default agent id.
#
# WHAT THIS DOES *NOT* CHANGE — two other labels also read "OpenClaw", and
# neither is reachable from config; don't expect this block to fix them:
#   1. The `#session:<id> OpenClaw:` byline in the untrusted conversation-context
#      block is HARDCODED at bot-*.js `toSessionTranscriptPromptMessage`:
#        const sender = entry.role === "assistant" ? "OpenClaw" : "User";
#      Only a patched dist or an upstream fix changes it.
#   2. The Telegram DISPLAY NAME (the `#NN <sender>:` byline, sourced from the
#      Telegram message cache) is the bot account's own name and is set in
#      @BotFather. openclaw never calls setMyName — confirmed absent from dist.
agent_name = os.environ.get("OASIS_AGENT_NAME", "").strip()
agent_emoji = os.environ.get("OASIS_AGENT_EMOJI", "").strip()
if agent_name:
    _agents_cfg = config.setdefault("agents", {})
    _agent_list = _agents_cfg.setdefault("list", [])
    if not isinstance(_agent_list, list):
        _agent_list = []
        _agents_cfg["list"] = _agent_list
    # Default agent id for this runtime; every fleet bot is a single-agent
    # container, so we address the one entry rather than enumerating.
    _agent_id = os.environ.get("OASIS_AGENT_ID", "").strip() or "main"
    _entry = next(
        (e for e in _agent_list if isinstance(e, dict) and str(e.get("id", "")).strip() == _agent_id),
        None,
    )
    if _entry is None:
        _entry = {"id": _agent_id}
        _agent_list.append(_entry)
    _identity = _entry.setdefault("identity", {})
    _identity["name"] = agent_name
    if agent_emoji:
        _identity["emoji"] = agent_emoji
    print(f"[entrypoint] agent identity: {agent_name}"
          f"{' ' + agent_emoji if agent_emoji else ''} (agents.list[id={_agent_id}].identity)")
else:
    print("[entrypoint] agent identity: OASIS_AGENT_NAME unset — outbound prefix "
          "will fall back to openclaw's built-in '[openclaw]'")

# ---- oasis-generation provider (durable GEN-003 wiring) ----------------
# Registers the unified inference gateway as an openai-completions provider IF
# this bot's .env carries a service token — so ONLY bots pointed at the gateway
# get it (Nimbus today; VH etc. can't reach it under the current egress rules).
# Replaces the hand-injected 2026-07-13 live block (which had only the two Gemma
# models) with the canonical catalog: local Gemma + the Bedrock-proxied frontier
# models (GEN-003). The apiKey comes from env (never hardcoded in this committed
# script) and MUST match the gateway's OASIS_GENERATION_SERVICE_TOKENS.
oasis_gen_token = os.environ.get("OASIS_GENERATION_TOKEN", "").strip()
oasis_gen_url = (
    os.environ.get("OASIS_GENERATION_URL", "").strip() or "http://host.docker.internal:8800/v1"
)
if oasis_gen_token:
    def _gen_model(mid, name, ctx, inputs=None):
        # input modalities: text everywhere; gpt-5.6-sol also takes images (its
        # mantle/Responses backend translates image_url -> input_image). The
        # Converse-backed models stay text-only (that path still drops images).
        # cost=0 because metering happens at the gateway, not per-bot.
        return {
            "id": mid,
            "name": name,
            "reasoning": True,
            "input": inputs or ["text"],
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": ctx,
            "maxTokens": 8192,
        }

    # Display names carry only the backend tag ("(Bedrock)" / "(Local)"); the
    # provider grouping ("oasis-generation") already supplies the rest, and
    # repeating it here just ran the model name off the left edge of the
    # Telegram model-picker button (unreadable). See §/models UX note in the
    # generative plan.
    # Roster trimmed to match the gateway catalog (2026-07-24, oasis-generation
    # dev): removed sonnet-4-6 / haiku-4-5 / gpt-oss-120b / deepseek-v3.2 /
    # llama-4-maverick; added claude-sonnet-5 and gpt-5.6-sol (the latter served
    # via the gateway's bedrock_mantle/Responses backend, 272K ctx). Keep in sync
    # with the gateway's catalog.py enabled entries — a model NOT enabled there
    # 404s here.
    gen_models = [
        _gen_model("gemma-4-12b-coder", "Gemma-4 12B Coder (Local)", 32768),
        _gen_model("gemma-4-12b-agentic", "Gemma-4 12B Agentic (Local)", 32768),
        _gen_model("claude-opus-4-8", "Claude Opus 4.8 (Bedrock)", 200000, ["text", "image"]),
        # Opus 5 added 2026-08-24 (ADM-048). Before this, Opus 5 reached ONLY
        # Nimbus, via a direct amazon-bedrock provider on Mike's personal IAM
        # key; the other six bots had no route to it and the gateway 404'd
        # `claude-opus-5`. Routing it through oasis-generation puts every bot on
        # one metered path. Must stay in sync with the gateway's catalog.py.
        _gen_model("claude-opus-5", "Claude Opus 5 (Bedrock)", 200000, ["text", "image"]),
        _gen_model("claude-sonnet-5", "Claude Sonnet 5 (Bedrock)", 200000, ["text", "image"]),
        _gen_model("gpt-5.6-sol", "GPT-5.6-sol (Bedrock)", 272000, ["text", "image"]),
        _gen_model("glm-5", "GLM-5 (Bedrock)", 131072),
    ]
    config.setdefault("models", {}).setdefault("providers", {})["oasis-generation"] = {
        "baseUrl": oasis_gen_url,
        "apiKey": oasis_gen_token,
        "api": "openai-completions",
        "models": gen_models,
    }
    print(f"[entrypoint] oasis-generation provider: {len(gen_models)} models @ {oasis_gen_url}")

    # Surface the WHOLE roster in /models. openclaw's default model picker lists
    # only the allowlist (agents.defaults.models) ∪ fallbacks ∪ default — and,
    # because a non-empty allowlist is also an ENFORCED gate, a model missing
    # from it can't even be `/model`-selected (not just hidden). So without this
    # the Bedrock roster registers but only the 2-3 fallback/default refs are
    # both visible and selectable. Seed each oasis-generation model into the
    # allowlist (seed-if-absent: the model-switcher plugin's curation of OTHER
    # providers is untouched; a deliberate removal returns on the next recreate,
    # acceptable given the intent is a stable, fully-visible roster).
    _allow = config.setdefault("agents", {}).setdefault("defaults", {}).setdefault("models", {})
    _seeded = [f"oasis-generation/{m['id']}" for m in gen_models
               if f"oasis-generation/{m['id']}" not in _allow]
    for _k in _seeded:
        _allow[_k] = {}
    if _seeded:
        print(f"[entrypoint] oasis-generation: seeded {len(_seeded)} model(s) into the /models allowlist")

# ---- durable model fallback chain (OPENCLAW_MODEL_FALLBACKS) ------------
# Comma-separated provider/model refs. Set per-bot in .env so the chain survives
# a volume wipe (the model-switcher plugin only manages primary + catalog, not
# fallbacks). Nimbus uses this to fail over a low-credit direct-Anthropic key to
# Bedrock Claude (billed to the personal oasis-dev account) before dropping tier.
fallbacks_env = os.environ.get("OPENCLAW_MODEL_FALLBACKS", "").strip()
if fallbacks_env:
    fbs = [f.strip() for f in fallbacks_env.split(",") if f.strip()]
    config["agents"]["defaults"]["model"]["fallbacks"] = fbs
    print(f"[entrypoint] model fallbacks: {fbs}")

# ---- Layer 2: exec allow-list policy (CLAW-032, safe-auto-mode §2c) -----
# openclaw's exec policy lives in its OWN file, exec-approvals.json (NOT
# openclaw.json): `defaults.{security,ask,askFallback}` = the gate mode,
# `agents.<id>.allowlist[]` = per-agent command allowlist (each entry matches an
# EXECUTABLE basename, optional argPattern — there is no full-command glob).
# openclaw normalize-PRESERVES this file on boot (the socket + reactively-learned
# `allow-always` approvals survive), so we MERGE, never clobber — that keeps the
# reactive Telegram-approval feeder's learnings durable across recreate (the
# continuity-always rule). GATED on OASIS_EXEC_SECURITY being set, so ONLY bots
# that opt in (Van Helsing today) get the allowlist gate; unset => openclaw's
# built-in default (security=full, i.e. unrestricted) is left untouched for the
# rest of the fleet. OASIS_EXEC_ALLOWLIST comes from one of two sources:
#   (a) CLAW-047 role compiler — if /app/role.yaml is mounted, the compiler
#       exports OASIS_EXEC_ALLOWLIST from role.yaml's ACTIVE exec.allow tier.
#   (b) compose env fallback — if no role.yaml, the hand-maintained env var
#       in the bot's compose overlay (legacy, pre-CLAW-047).
exec_security = os.environ.get("OASIS_EXEC_SECURITY", "").strip()
if exec_security:
    ea_path = config_path.parent / "exec-approvals.json"
    try:
        ea = json.loads(ea_path.read_text())
        if not isinstance(ea, dict):
            ea = {}
    except Exception:
        ea = {}
    ea.setdefault("version", 1)
    # mode in defaults (inherited by all this bot's agents); env-authoritative.
    ea_def = ea.setdefault("defaults", {})
    # Valid openclaw enums (6.11): security ∈ {deny, allowlist, full};
    # ask ∈ {off, on-miss, always}; askFallback ∈ {deny, ...}. "on-miss" = ask a
    # reviewer only when a command MISSES the allowlist (allowlisted runs silent).
    # An invalid value is DROPPED by openclaw's sanitizer (e.g. "on" → ask unset →
    # no escalation), so these defaults must be exact.
    ea_def["security"] = exec_security
    ea_def["ask"] = os.environ.get("OASIS_EXEC_ASK", "").strip() or "on-miss"
    ea_def["askFallback"] = os.environ.get("OASIS_EXEC_ASK_FALLBACK", "").strip() or "deny"
    # autoReview: when true, an allowlist MISS is first judged by openclaw's
    # model-backed exec reviewer (see src/infra/exec-auto-review.ts) — allow-once
    # for a clearly-safe single execution, otherwise fall through to the ask path
    # (which, with mode=session forwarding below, prompts Mike in Telegram). This
    # is what makes a real shell usable safely: the reviewer reasons about the
    # WHOLE command (pipeline segments, cwd, env keys, inline-eval) in context
    # instead of a basename allowlist match, and it treats the command as
    # untrusted data (won't follow embedded instructions). The static allowlist
    # stays as the zero-latency fast-path; only misses pay a review. Needs
    # ask != "off" to have an escalation target. Env-gated + default OFF so a bot
    # that doesn't opt in keeps the strict static-allowlist-only floor. Reviewer
    # MODEL is set separately via OASIS_EXEC_REVIEWER_MODEL (tools.exec.reviewer)
    # below; omit it to reuse the bot's own agent model.
    # NOTE (6.11, verified live 2026-07-20): autoReview is NOT configured here.
    # `autoReview` is not a writable field in exec-approvals.json — it is DERIVED
    # from the exec MODE, and the mode knob lives in openclaw.json under
    # `tools.exec.mode` (schema: "Normalized exec policy mode. Prefer this over
    # raw security/ask knobs."). Writing autoReview into these defaults is
    # silently dropped by openclaw's sanitizer, which is why autoReview never
    # fired on this fleet despite OASIS_EXEC_AUTOREVIEW=1 on every bot.
    # See Layer 2c below, which now sets tools.exec.mode.
    # allowlist in agents.main — UNION seed patterns with existing entries,
    # dedup by (pattern, argPattern). Preserve learned entries verbatim (they
    # carry source/lastUsedAt). Patterns are lowercased by openclaw on load.
    agents_ea = ea.setdefault("agents", {})
    main_ea = agents_ea.setdefault("main", {})
    existing = main_ea.get("allowlist")
    existing = existing if isinstance(existing, list) else []
    seen = set()
    merged = []
    for e in existing:
        if isinstance(e, dict) and str(e.get("pattern", "")).strip():
            k = (str(e["pattern"]).strip().lower(), str(e.get("argPattern", "")).strip().lower())
            if k not in seen:
                seen.add(k); merged.append(e)
    seed_raw = os.environ.get("OASIS_EXEC_ALLOWLIST", "")
    for tok in seed_raw.replace(";", "\n").replace(",", "\n").splitlines():
        p = tok.strip()
        if not p or p.startswith("#"):
            continue
        k = (p.lower(), "")
        if k not in seen:
            seen.add(k); merged.append({"pattern": p})
    main_ea["allowlist"] = merged
    ea_path.write_text(json.dumps(ea, indent=2) + "\n")
    try:
        os.chmod(ea_path, 0o600)
    except OSError:
        pass
    print(f"[entrypoint] exec policy: security={ea_def['security']} ask={ea_def['ask']} "
          f"askFallback={ea_def['askFallback']} "
          f"allowlist={len(merged)} patterns (seeded {len(merged) - len(existing)} new)")

# ---- Layer 2b: exec-approval FORWARDING to a channel (CLAW-035) ---------
# openclaw's native `approvals.exec` (in openclaw.json) routes a miss's approval
# prompt to an operational CHANNEL. Without it, the ask=on-miss path has the
# agent's own gateway-client try to self-grant the `operator.approvals` scope,
# which needs device pairing a headless bot lacks — the GatewayTransportError
# ("pairing required") the 2026-07-15 live test surfaced. mode="session" delivers
# the prompt back to the ORIGIN chat; for a Telegram-driven turn that's the
# operator's DM, so no chat-id needs hardcoding. modes: session|targets|both.
# Gated on OASIS_EXEC_APPROVAL_MODE (unset => forwarding stays off, openclaw
# default). agentFilter scopes it to this bot's main agent.
exec_approval_mode = os.environ.get("OASIS_EXEC_APPROVAL_MODE", "").strip()
if exec_approval_mode:
    approvals_cfg = config.setdefault("approvals", {})
    exec_fwd = approvals_cfg.setdefault("exec", {})
    exec_fwd["enabled"] = True
    exec_fwd["mode"] = exec_approval_mode
    exec_fwd.setdefault("agentFilter", ["main"])
    print(f"[entrypoint] exec-approval forwarding: enabled mode={exec_approval_mode} agentFilter=['main']")

# ---- Layer 2c: exec reviewer model (tools.exec.reviewer.model) -----------
# Optional cheap/fast model for the OASIS_EXEC_AUTOREVIEW reviewer. Omit to
# reuse the bot's own agent model (guaranteed reachable + valid, but pricier per
# miss). Set to a small model to cut review latency/cost. CONSTRAINT: must be a
# model this bot can actually reach — sandboxed bots egress-lock to the core
# allowlist whose only model host is .anthropic.com, so use anthropic/* (e.g.
# anthropic/claude-haiku-4-5) or leave unset. A google/* or openai/* reviewer
# would hang then time out (30s) → fall back to human ask on every miss.
exec_reviewer_model = os.environ.get("OASIS_EXEC_REVIEWER_MODEL", "").strip()
if exec_reviewer_model:
    tools_cfg = config.setdefault("tools", {})
    exec_tcfg = tools_cfg.setdefault("exec", {})
    reviewer_tcfg = exec_tcfg.setdefault("reviewer", {})
    reviewer_tcfg["model"] = exec_reviewer_model
    print(f"[entrypoint] exec reviewer model: {exec_reviewer_model}")

# ---- Layer 2d: exec MODE — the real autoReview switch (fixed 2026-07-20) -----
# ROOT CAUSE this fixes: OASIS_EXEC_AUTOREVIEW=1 was set fleet-wide, but nothing
# consumed it. autoReview is not a writable field — it is DERIVED from the exec
# mode, and the mode knob lives HERE, in openclaw.json `tools.exec.mode`, whose
# 6.11 schema says: "Normalized exec policy mode. Prefer this over raw
# security/ask knobs." The 6.11 mode table (resolveExecPolicyForMode):
#     allowlist → security=allowlist, ask=off,     autoReview=false
#     ask       → security=allowlist, ask=on-miss, autoReview=false
#     auto      → security=allowlist, ask=on-miss, autoReview=true   ← only one
#     full      → security=full
# With mode unset openclaw BACK-DERIVES it from (security, ask); our
# allowlist+on-miss pair lands on "ask" → autoReview=false. That is why every
# allowlist miss fell through to the human ask path, and why the three test bots
# on 2026-07-20 all died with a mislabeled "approval-timeout".
# Gated on the SAME env var, and only applied when the bot's exec policy is
# actually the allowlist+on-miss shape — so a bot deliberately pinned at ask=off
# (Van Helsing, until the uid-exec sandbox lands) is never silently escalated.
_auto_review = os.environ.get("OASIS_EXEC_AUTOREVIEW", "").strip().lower() in (
    "1", "true", "yes", "on")
# Mirror Layer 2's resolution exactly. Both only mean anything when the bot opted
# into the allowlist gate (OASIS_EXEC_SECURITY set); otherwise openclaw's own
# defaults (security=full) apply and mode=auto would be wrong.
_exec_security = os.environ.get("OASIS_EXEC_SECURITY", "").strip()
_exec_ask = (os.environ.get("OASIS_EXEC_ASK", "").strip() or "on-miss") if _exec_security else ""
if _auto_review and _exec_security == "allowlist" and _exec_ask == "on-miss":
    tools_cfg = config.setdefault("tools", {})
    exec_tcfg = tools_cfg.setdefault("exec", {})
    exec_tcfg["mode"] = "auto"
    print("[entrypoint] exec mode: auto (autoReview ON — misses are model-reviewed "
          "before falling back to human approval)")
elif _auto_review:
    print(f"[entrypoint] exec mode: NOT set to auto — OASIS_EXEC_AUTOREVIEW is on but "
          f"security={_exec_security or '(unset)'}/ask={_exec_ask or '(unset)'} is not the "
          f"allowlist+on-miss shape; autoReview stays OFF")

# ---- Layer 2e: EXPLICIT exec-mode override (CLAW-073, reviewer-gated exec) ----
# When OASIS_EXEC_MODE is set it is AUTHORITATIVE and wins over Layer 2d + the raw
# security/ask knobs (schema: "Normalized exec policy mode. Prefer this over raw
# security/ask knobs."). openclaw's resolveExecPolicyForMode (dist, verified
# 2026-07-27): full → security=full, ask=off, autoReview=false; allowlist →
# security=allowlist, ask=off. mode=full removes the deny-by-default allowlist
# FLOOR so the oasis-reviewer before_tool_call hook becomes the SOLE exec gate —
# safe single commands auto-allow, compound/destructive/self-runtime escalate|deny,
# and an APPROVED command actually RUNS (under allowlist it was vetoed AFTER
# approval → the CLAW-072 conflict Mike hit). Set EXPLICITLY (not just via
# OASIS_EXEC_SECURITY) because openclaw.json persists across recreates: a stale
# tools.exec.mode from a prior boot would clamp security back down via
# minSecurity(mode.security, agent.security). SAFETY: only meaningful with the
# reviewer ENFORCING; the self-modification vector is covered by the reviewer's
# fleet-always `openclaw` escalate + control-plane :ro mount + locked egress.
_exec_mode_override = os.environ.get("OASIS_EXEC_MODE", "").strip()
if _exec_mode_override:
    tools_cfg = config.setdefault("tools", {})
    exec_tcfg = tools_cfg.setdefault("exec", {})
    exec_tcfg["mode"] = _exec_mode_override
    print(f"[entrypoint] exec mode: {_exec_mode_override} (EXPLICIT override — the "
          f"oasis-reviewer hook is the sole exec gate)")

# ---- Layer 2f: EXPLICIT thinking-level default (UX: reasoning off the answer lane) ----
# openclaw's resolveThinkingDefault (agents/model-thinking-default.ts:58-63) HARD-CODES
# anthropic claude-opus-4-7 → "off" unless a config override exists, and it consults
# agents.defaults.thinkingDefault (line 54-56) BEFORE that hard-off. With thinking off a
# no-thinking model does its between-step planning in the VISIBLE answer text — the exact
# mechanism behind Yes Man's per-step re-greeting / narration (verified: session
# 066066dc, 0 thinking blocks, 6 greetings fused with real planning). Setting this
# relocates that reasoning into native thinking blocks, which openclaw routes to a
# SEPARATE, in-place-edited reasoning lane (extensions/telegram bot-message-dispatch) —
# so the answer lane stays clean (greet once + one report) and reasoning quality lifts.
# Env-gated so only opted-in bots get it (yesman); unset → openclaw's per-model default
# (off for opus-4-7) stands. Cost: modest thinking tokens/turn (output, not cached).
_thinking_level = os.environ.get("OASIS_THINKING_LEVEL", "").strip().lower()
if _thinking_level:
    _agents_defaults = config.setdefault("agents", {}).setdefault("defaults", {})
    _agents_defaults["thinkingDefault"] = _thinking_level
    print(f"[entrypoint] thinking default: {_thinking_level} (EXPLICIT override — "
          f"reasoning moves to native thinking blocks / reasoning lane)")

# ---- BOOT ASSERTIONS: the media pins (2026-08-24) -----------------------
# Both media routes are single unguarded assignments in this file with no test
# and no health check. The media audit found that inbound audio routing depends
# entirely on `tools.media.audio.models` naming oasis-voice FIRST: the plugin
# ships without a manifest `contracts` block on purpose, which makes it
# invisible to media-understanding's autoPriority registry, so nothing else
# would select it. If a future edit drops or reorders that pin, transcription
# silently stops routing to the local sidecar — no error, no log line, the
# failure only shows up as voice notes that never get answered.
# Outbound TTS has the same shape via `messages.tts.provider`.
# These assertions FAIL THE BOOT rather than let either pin rot silently.
_audio_models = config.get("tools", {}).get("media", {}).get("audio", {}).get("models")
if not isinstance(_audio_models, list) or not _audio_models:
    raise SystemExit(
        "[entrypoint] FATAL: tools.media.audio.models is missing or empty. "
        "Inbound voice transcription would silently stop. Restore the "
        "oasis-voice pin in this script."
    )
if _audio_models[0].get("provider") != "oasis-voice":
    raise SystemExit(
        f"[entrypoint] FATAL: tools.media.audio.models[0].provider is "
        f"{_audio_models[0].get('provider')!r}, expected 'oasis-voice'. "
        "oasis-voice has no manifest contracts block, so autoPriority cannot "
        "select it — it MUST be pinned first or transcription leaves the fleet."
    )
_tts_provider = config.get("messages", {}).get("tts", {}).get("provider")
if _tts_provider != "oasis-voice":
    raise SystemExit(
        f"[entrypoint] FATAL: messages.tts.provider is {_tts_provider!r}, "
        "expected 'oasis-voice'. Outbound voice replies would fall through to "
        "a cloud TTS provider or fail."
    )
print(f"[entrypoint] media pins OK: audio={_audio_models[0]['provider']}/"
      f"{_audio_models[0].get('model')} tts={_tts_provider}")

# ---- IMAGE route visibility (2026-08-25, item 3 — REVISED) ------------------
# The original plan was "make tools.media.image explicit so images stop
# depending on an implicit behaviour". That plan was WRONG and would have
# BROKEN images on the five sandboxed bots. Recording why, because the wrong
# fix is the intuitive one:
#
#   media-understanding/runner.ts:1085 skips image understanding when the agent
#   model has native vision — but ONLY when there is no explicit config:
#       capability === "image" && !hasExplicitImageUnderstandingConfig({config})
#   and hasExplicitImageUnderstandingConfig is simply
#       (config?.models?.length ?? 0) > 0                        (runner.ts:724)
#
# So WRITING tools.media.image.models is exactly what DISABLES the free,
# local, zero-egress native-vision path and forces images out to a provider.
# The only image-capable provider configured here is google, and the five
# sandboxed bots cannot reach it (HTTP 000, measured 2026-08-25). The "make it
# explicit" fix would have turned working images into broken images.
#
# The real requirement was VISIBILITY, not configuration. So: assert the skip
# is still available, name the route in the boot log, and warn when the primary
# model is not a model we know has native vision.
#
# Deliberately NOT fatal. Images are not load-bearing, and a hard boot failure
# on a model bump would take the whole fleet down to protect a soft capability —
# the wrong trade, and the CLAW-106 lesson about blast radius.
_img_cfg = config.get("tools", {}).get("media", {}).get("image", {}) or {}
if (_img_cfg.get("models") or []):
    print("[entrypoint] WARNING image: an explicit tools.media.image.models is set, "
          "which DISABLES the native-vision fast path. On a sandboxed bot the "
          "provider is unreachable and inbound images will fail. Remove it unless "
          "this bot genuinely has provider reach.")
else:
    _primary = ((config.get("agents", {}).get("defaults", {}) or {}).get("model", {}) or {}).get("primary", "")
    # Models we have CONFIRMED carry native vision. Extend deliberately.
    _NATIVE_VISION_PREFIXES = (
        "anthropic/claude-sonnet-", "anthropic/claude-opus-", "anthropic/claude-haiku-",
        "google/gemini-", "amazon-bedrock/anthropic.claude-",
    )
    if _primary.startswith(_NATIVE_VISION_PREFIXES):
        print(f"[entrypoint] media image: native vision via {_primary} (no provider, no egress)")
    else:
        print(f"[entrypoint] WARNING image: primary model {_primary!r} is not in the known "
              "native-vision list. Inbound images may be silently ignored. Either confirm "
              "the model has vision and add its prefix to _NATIVE_VISION_PREFIXES, or give "
              "this bot a reachable tools.media.image provider.")

config_path.parent.mkdir(parents=True, exist_ok=True)
config_path.write_text(json.dumps(config, indent=2) + "\n")
print(f"[entrypoint] wrote {config_path}")
PY

# ---- banner ------------------------------------------------------------
masked="${OPENCLAW_GATEWAY_TOKEN:0:8}…(redacted)"
if [[ "${OASIS_SHOW_TOKEN:-0}" == "1" ]]; then
  masked="${OPENCLAW_GATEWAY_TOKEN}"
fi
cat <<BANNER
==============================================================
 oasis-claw runtime
   openclaw bind  : ${BIND} (inside container :${PORT})
   gateway token  : ${masked}
   plugins        : prompt-injection-reporting, secrets-vault,
                    approval-gate, session-history, dot-swarm,
                    clawhub-skill-audit, model-switcher,
                    oasis-voice, browser (+ bundled memory-core)
   browser eval   : disabled (per CLAW-014 audit; per-session opt-in only)
   config file    : ${CONFIG_FILE}
==============================================================
BANNER

# ---- heartbeat: keep OFF via an empty HEARTBEAT.md (cron-driven fleet) --
# Standing decision (2026-07-13): NO autonomous heartbeat until a proxy-signal
# monitor exists — the daily rhythm is driven entirely by openclaw cron
# (memory-core dreaming + sleep-cycle deep-sleep).
#
# openclaw skips the heartbeat LLM call ONLY when HEARTBEAT.md is "effectively
# empty" (isHeartbeatContentEffectivelyEmpty: whitespace / #-headers / HTML
# comments / EMPTY list stubs only). The shipped default template is NOT empty
# — its "## Related / - [Heartbeat config](…)" footer is a non-empty list item,
# so the heartbeat fires a real LLM on every wake (verified 2026-07-13: the
# driver behind YesMan's non-skipped wakes). openclaw's runtime gate
# (`system heartbeat disable`) is unreliable at boot — it needs a paired/
# elevated gateway scope that boot tokens don't always have (failed on YesMan/
# VH, worked on Nimbus). So we guarantee OFF the file way: write a genuinely-
# empty HEARTBEAT.md (comment/header lines only) so every wake short-circuits
# to skipReason=empty-heartbeat-file — no LLM, no tokens, no gateway call.
# Written pre-gateway so the very first wake already sees it. When
# OASIS_HEARTBEAT_DISABLED=0 (proxy-signal-monitor era) we stop managing the
# file and let its contents drive wakes again. NOTE: '#'-prefixed lines read as
# markdown ATX headers, which the empty-check explicitly allows — do not add
# non-empty '- ' list items here or the heartbeat will start firing again.
if [[ "${OASIS_HEARTBEAT_DISABLED:-1}" == "1" ]]; then
  printf '%s\n' \
    "# Heartbeat intentionally DISABLED (oasis-claw cron-driven fleet)." \
    "# A file with only comments/headers is 'effectively empty' → openclaw" \
    "# skips the heartbeat LLM call (skipReason=empty-heartbeat-file)." \
    "# The daily rhythm runs via openclaw cron: memory-core dreaming +" \
    "# sleep-cycle deep-sleep. Re-enable by setting OASIS_HEARTBEAT_DISABLED=0" \
    "# and adding proxy-signal tasks below this line." \
    > "${CONFIG_DIR}/workspace/HEARTBEAT.md"
  echo "[entrypoint] heartbeat OFF: wrote empty HEARTBEAT.md (set OASIS_HEARTBEAT_DISABLED=0 to re-enable)"
fi

# ---- sleep-cycle: NO cron needed --------------------------------------------
# The deep-sleep reset is openclaw's OWN native session reset (session.reset
# policy, mode "daily", seeded above under `session.resetByType.direct`). It
# archives the long-lived transcript and starts a fresh session on schedule
# with no cron, no agent tool, and no operator.admin scope — which is exactly
# why a fresh headless bot can do it (the CLI `cron add`/`sessions.reset` path
# is gated behind operator.admin the bot can't self-grant). The sleep-cycle
# plugin rides that native reset via its `before_reset` hook (stages the waking
# summary) and keeps a `sleep_deep` TOOL only for manual on-demand resets. See
# .swarm/KOLMOGOROV_SLEEP_ARCHITECTURE.md for the full rationale.

# ---- git / GitHub access (CLAW-047) -----------------------------------------
# GIT_CONFIG_GLOBAL points into the VOLUME because the rootfs is read_only —
# $HOME/.gitconfig is not writable. Exported so the agent's own `git` calls
# (children of the gateway) inherit the same config. When this bot has a
# fine-grained PAT (GH_TOKEN in its .env) we wire commit identity + a no-network
# credential helper (serves GH_TOKEN for github.com https; no boot-time github
# call, so egress-locked Van Helsing still boots) + the global pre-push
# guardrail hook. The push allowlist (OASIS_GIT_REPOS) is read LIVE from the env
# by the `git` wrapper — nothing to materialize. gh reads GH_TOKEN from the env.
export GIT_CONFIG_GLOBAL="${CONFIG_DIR}/.gitconfig"
git config --global core.hooksPath /usr/local/lib/oasis-git-policy/hooks 2>/dev/null || true
git config --global safe.directory '*' 2>/dev/null || true
# --replace-all, not a plain set, on every credential.helper line below.
# CLAW-102 (2026-08-18, remote VDI deployment): this file lives inside a volume that
# survives every container recreation (GIT_CONFIG_GLOBAL points into it, not
# $HOME/.gitconfig — see comment above), so any earlier boot, manual
# recovery step, or auth-mode switch that ever left a SECOND value for this
# key (e.g. via `git config --add`) makes every later boot's plain
# `git config <key> <value>` fail outright with "cannot overwrite multiple
# values with a single value" -- and this script has no `|| true` on these
# lines, so that failure kills the entire entrypoint, and the whole
# container exits before the gateway ever starts. `--replace-all` collapses
# any number of existing values (zero, one, or many) down to exactly the one
# given here, so it is safe regardless of what an earlier boot left behind.
if [ -n "${GH_APP_ID:-}" ]; then
  # GitHub App mode (preferred): the oasis-gh-app helper mints a SHORT-LIVED,
  # per-repo-scoped installation token on demand from GH_APP_PRIVATE_KEY_B64 —
  # nothing long-lived in .env, centrally revocable. useHttpPath gives the helper
  # the owner/repo so it can down-scope the token to just that repo.
  git config --global user.name  "${OASIS_GIT_USER_NAME:-oasis-claw bot}"
  git config --global user.email "${OASIS_GIT_USER_EMAIL:-bots@oasis-x.io}"
  git config --global --replace-all credential."https://github.com".helper oasis-gh-app
  git config --global --replace-all credential."https://github.com".useHttpPath true
  echo "[entrypoint] git wired for GitHub App ${GH_APP_ID} (per-repo tokens on demand; push allowlist='${OASIS_GIT_REPOS:-<none set>}')"
elif [ -n "${GH_TOKEN:-}" ]; then
  # PAT fallback: static per-bot fine-grained token served for github.com https.
  git config --global user.name  "${OASIS_GIT_USER_NAME:-oasis-claw bot}"
  git config --global user.email "${OASIS_GIT_USER_EMAIL:-bots@oasis-x.io}"
  git config --global --replace-all credential."https://github.com".helper oasis-gh
  echo "[entrypoint] git+gh wired for GitHub PAT (user='${OASIS_GIT_USER_NAME:-oasis-claw bot}', push allowlist='${OASIS_GIT_REPOS:-<none set>}')"
elif gh auth status >/dev/null 2>&1; then
  # Personal gh CLI sign-in (Mike, 2026-08-18, House): `gh auth login` run
  # interactively inside the container (there is no non-interactive path for
  # this mode -- device-flow OAuth needs a human at a browser). gh's own
  # token store already lands under XDG_CONFIG_HOME
  # (/home/node/.openclaw/config, set two lines above CONFIG_DIR's own export
  # and already inside the persistent oasis_openclaw_home_house volume, which
  # survives --force-recreate unlike the container's writable layer) — so the
  # sign-in itself needs no new mount. What was missing: this script never
  # checked whether gh ALREADY has a session, so a bot with no GH_APP_ID/
  # GH_TOKEN fell straight to the "no push" branch below even after a
  # successful interactive sign-in, leaving git itself unwired. `gh auth
  # login` sometimes offers to wire git for you (a y/n prompt mid-flow) but
  # that's easy to answer "n" to by accident or skip via --with-token, so this
  # branch makes the wiring unconditional and idempotent on every boot rather
  # than depending on that prompt having been answered correctly once.
  # Delegates git's HTTPS credential lookup to gh itself — the same mechanism
  # `gh auth setup-git` configures — so `git push`/`git fetch` and `gh pr
  # list` etc. share the one signed-in session. Trade-off Mike chose
  # explicitly over GitHub App mode: this ties the bot's git access to
  # whichever personal GitHub account is signed in, not a narrow bot
  # identity.
  git config --global user.name  "${OASIS_GIT_USER_NAME:-oasis-claw bot}"
  git config --global user.email "${OASIS_GIT_USER_EMAIL:-bots@oasis-x.io}"
  git config --global --replace-all credential."https://github.com".helper "!gh auth git-credential"
  echo "[entrypoint] git wired for gh CLI personal sign-in (push allowlist='${OASIS_GIT_REPOS:-<none set>}')"
else
  echo "[entrypoint] no GH_APP_ID/GH_TOKEN/gh-cli-signin — git limited to anonymous public reads (no push)"
fi

exec openclaw gateway --bind "${BIND}" --port "${PORT}"
