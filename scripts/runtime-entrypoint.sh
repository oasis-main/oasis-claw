#!/usr/bin/env bash
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

mkdir -p "${CONFIG_DIR}" "${CONFIG_DIR}/workspace" "${CONFIG_DIR}/logs/attacks" \
         "${CONFIG_DIR}/logs/history" "${CONFIG_DIR}/state/secrets" \
         "${CONFIG_DIR}/.swarm"

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

# ---- seed .swarm/ for dot-swarm first-boot -----------------------------
if [[ ! -f "${CONFIG_DIR}/.swarm/state.md" ]]; then
  cat > "${CONFIG_DIR}/.swarm/state.md" <<'MD'
# oasis-claw swarm state

First-boot placeholder. Replace with current handoff state, or let
dot-swarm's `compact` tool append a handoff section on its next run.
MD
fi
if [[ ! -f "${CONFIG_DIR}/.swarm/queue.md" ]]; then
  cat > "${CONFIG_DIR}/.swarm/queue.md" <<'MD'
# oasis-claw swarm queue

- [ ] verify all 6 plugins loaded (`openclaw plugins list`)
- [ ] add Anthropic credentials to start an LLM turn
MD
fi

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
  # clawhub-skill-audit's audit-prompt.ts intentionally contains the
  # exact "dynamic code execution" string patterns the auditor looks
  # FOR in third-party skills. openclaw's install-time scanner reads
  # those patterns and refuses to install. False positive on our own
  # auditor's source — same shape as the secrets-vault override.
  [clawhub-skill-audit]="--dangerously-force-unsafe-install"
  [model-switcher]=""
  [oasis-voice]=""
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
TOPOLOGY_KEYS = {"endpoint", "tts_voice", "reachRoots", "enforce"}

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
merge_config("dot-swarm", {
    "swarmDir": str(home / ".openclaw/.swarm"),
    "registerSwarmReadTool": True,
})
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
config["agents"]["defaults"]["compaction"]["provider"] = "swarm-compact"

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
# Order = fallback order: oasis-voice (local Moonshine) first; openai
# (gpt-4o-transcribe) second so a sidecar outage degrades to cloud rather
# than failing the transcription outright. Drop the openai entry if you
# want strict local-only. This is the inbound counterpart of the
# `messages.tts.provider` outbound pin below, and is hard-overwritten on
# every boot for the same reason that pin is.
config.setdefault("tools", {})
config["tools"].setdefault("media", {})
config["tools"]["media"].setdefault("audio", {})
config["tools"]["media"]["audio"]["enabled"] = True
config["tools"]["media"]["audio"]["models"] = [
    {"provider": "oasis-voice", "model": "moonshine-base"},
    {"provider": "openai", "model": "gpt-4o-transcribe"},
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
# Set via .env + make recreate, or live via `openclaw config set` + make restart.
# Provider strings: "anthropic/claude-sonnet-4-6", "gemini/gemini-2.0-flash",
#   "openai/gpt-4o", "bedrock/anthropic.claude-sonnet-4-5-v1:0",
#   "ollama/llama3.3" (needs host.docker.internal reachable from container).
# Leave unset to keep a model already configured (e.g. hot-swapped via
# model-switcher and persisted in openclaw.json); if none is configured, fall
# back to Claude rather than openclaw's openai/gpt-5.5 built-in default.
default_model = os.environ.get("OPENCLAW_DEFAULT_MODEL", "").strip() or None
config.setdefault("agents", {})
config["agents"].setdefault("defaults", {})
config["agents"]["defaults"].setdefault("model", {})
existing_primary = config["agents"]["defaults"]["model"].get("primary")
if default_model:
    # Env always wins — lets .env rotation change the active model on recreate.
    config["agents"]["defaults"]["model"]["primary"] = default_model
    print(f"[entrypoint] default model set to: {default_model}")
elif not existing_primary:
    # No env override and nothing already configured (fresh fleet bot): default
    # to Claude instead of falling through to openclaw's openai/gpt-5.5 built-in,
    # which needs an OpenAI key no bot has. Overridable via OPENCLAW_DEFAULT_MODEL.
    fallback_model = "anthropic/claude-sonnet-5"
    config["agents"]["defaults"]["model"]["primary"] = fallback_model
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
if [ -n "${GH_APP_ID:-}" ]; then
  # GitHub App mode (preferred): the oasis-gh-app helper mints a SHORT-LIVED,
  # per-repo-scoped installation token on demand from GH_APP_PRIVATE_KEY_B64 —
  # nothing long-lived in .env, centrally revocable. useHttpPath gives the helper
  # the owner/repo so it can down-scope the token to just that repo.
  git config --global user.name  "${OASIS_GIT_USER_NAME:-oasis-claw bot}"
  git config --global user.email "${OASIS_GIT_USER_EMAIL:-bots@oasis-x.io}"
  git config --global credential."https://github.com".helper oasis-gh-app
  git config --global credential."https://github.com".useHttpPath true
  echo "[entrypoint] git wired for GitHub App ${GH_APP_ID} (per-repo tokens on demand; push allowlist='${OASIS_GIT_REPOS:-<none set>}')"
elif [ -n "${GH_TOKEN:-}" ]; then
  # PAT fallback: static per-bot fine-grained token served for github.com https.
  git config --global user.name  "${OASIS_GIT_USER_NAME:-oasis-claw bot}"
  git config --global user.email "${OASIS_GIT_USER_EMAIL:-bots@oasis-x.io}"
  git config --global credential."https://github.com".helper oasis-gh
  echo "[entrypoint] git+gh wired for GitHub PAT (user='${OASIS_GIT_USER_NAME:-oasis-claw bot}', push allowlist='${OASIS_GIT_REPOS:-<none set>}')"
else
  echo "[entrypoint] no GH_APP_ID/GH_TOKEN — git limited to anonymous public reads (no push)"
fi

exec openclaw gateway --bind "${BIND}" --port "${PORT}"
