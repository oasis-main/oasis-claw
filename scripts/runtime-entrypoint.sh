#!/usr/bin/env bash
#
# Container entrypoint for oasis-claw-runtime.
#
# 1. Ensure ~/.openclaw exists; mint a gateway auth token if not provided.
# 2. Run `openclaw plugins install --link --force` for each of our 6 baked-in
#    extensions so the loader registers them in the persisted plugin registry
#    that lives in ~/.openclaw (volume-persisted).
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
agent-primitives' `compact` tool overwrite this on its next run.
MD
fi
if [[ ! -f "${CONFIG_DIR}/.swarm/queue.md" ]]; then
  cat > "${CONFIG_DIR}/.swarm/queue.md" <<'MD'
# oasis-claw swarm queue

- [ ] verify all 6 plugins loaded (`openclaw plugins list`)
- [ ] add Anthropic credentials to start an LLM turn
MD
fi

# ---- install our 6 extensions via the openclaw plugin registry ---------
# `--link` points the registry at /app/extensions/<id>/ (read-only image) so
# we don't duplicate code. `--force` is incompatible with --link, so we skip
# install if the plugin is already in the registry from a prior boot.
#
# secrets-vault triggers the dangerous-code detector (env var + network send,
# which is the intentional Playwright form-fill path that keeps plaintext out
# of tool-call history). We pass --dangerously-force-unsafe-install only for
# that plugin because it's our code and we accept the override.
declare -A PLUGINS=(
  [prompt-injection-reporting]=""
  [secrets-vault]="--dangerously-force-unsafe-install"
  [approval-gate]=""
  [session-history]=""
  [dot-swarm]=""
  [agent-primitives]=""
)

# Probe what's already registered so re-runs don't fail.
INSTALLED_LIST="$(openclaw plugins list 2>/dev/null || true)"

for p in "${!PLUGINS[@]}"; do
  if printf '%s\n' "${INSTALLED_LIST}" | grep -qE "^[│| ]+${p}[ │|]" 2>/dev/null \
     || printf '%s\n' "${INSTALLED_LIST}" | grep -q "/app/extensions/${p}"; then
    echo "[entrypoint] plugin already linked: ${p}"
    continue
  fi
  echo "[entrypoint] linking plugin: ${p}"
  # shellcheck disable=SC2086
  if ! openclaw plugins install --link ${PLUGINS[$p]} "/app/extensions/${p}" 2>&1 | tail -3; then
    echo "[entrypoint] WARN: failed to link ${p} (continuing)" >&2
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
inbound_token = (
    os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    or os.environ.get("OASIS_TELEGRAM_BOT_TOKEN", "").strip()
    or None
)
operator_user_id = os.environ.get("OASIS_TELEGRAM_CHAT_ID", "").strip() or None
if inbound_token:
    channels = config.setdefault("channels", {})
    tg = channels.setdefault("telegram", {})
    tg["enabled"] = True
    tg["botToken"] = inbound_token  # config beats env per docs
    tg["dmPolicy"] = "allowlist"
    if operator_user_id and operator_user_id.lstrip("-").isdigit():
        existing_allow = tg.get("allowFrom") or []
        if operator_user_id not in existing_allow:
            existing_allow.append(operator_user_id)
        tg["allowFrom"] = existing_allow
    # Group adds disabled by default; require explicit opt-in via .env later.
    tg.setdefault("groups", {})

# ---- per-plugin config (registration is handled by `plugins install`) ----
plugins = config.setdefault("plugins", {})
entries = plugins.setdefault("entries", {})

TELEGRAM_KEYS = {"telegramBotToken", "telegramChatId", "telegramAlertChatId"}

def merge_config(plugin_id, defaults, hooks=None):
    entry = entries.setdefault(plugin_id, {})
    entry["enabled"] = entry.get("enabled", True)
    cfg = entry.setdefault("config", {})
    for k, v in defaults.items():
        # Telegram creds always reflect current env (so rotating creds via
        # `.env` + recreate works). Other keys are user-overridable defaults.
        if k in TELEGRAM_KEYS:
            cfg[k] = v
        else:
            cfg.setdefault(k, v)
    if hooks:
        h = entry.setdefault("hooks", {})
        for k, v in hooks.items():
            h.setdefault(k, v)

# Telegram creds flow from compose env (.env on host) into plugin config here.
# We DON'T log values; entries.* are written to disk inside the volume only.
tg_token = os.environ.get("OASIS_TELEGRAM_BOT_TOKEN", "").strip() or None
tg_chat = os.environ.get("OASIS_TELEGRAM_CHAT_ID", "").strip() or None

prompt_inj_cfg = {"attackLogDir": str(home / ".openclaw/logs/attacks")}
secrets_cfg = {"secretsDir": str(home / ".openclaw/state/secrets")}
approval_cfg = {}
if tg_token:
    prompt_inj_cfg["telegramBotToken"] = tg_token
    secrets_cfg["telegramBotToken"] = tg_token
    approval_cfg["telegramBotToken"] = tg_token
if tg_chat:
    # Naming differs between plugins by design (alert vs interactive chat).
    prompt_inj_cfg["telegramAlertChatId"] = tg_chat
    secrets_cfg["telegramAlertChatId"] = tg_chat
    approval_cfg["telegramChatId"] = tg_chat

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
merge_config("dot-swarm", {
    "swarmDir": str(home / ".openclaw/.swarm"),
    "registerSwarmReadTool": True,
})
merge_config("agent-primitives", {
    "swarmDir": str(home / ".openclaw/.swarm"),
    "historyDir": str(home / ".openclaw/logs/history"),
})

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
                    agent-primitives
   config file    : ${CONFIG_FILE}
==============================================================
BANNER

exec openclaw gateway --bind "${BIND}" --port "${PORT}"
