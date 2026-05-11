#!/usr/bin/env bash
#
# Container entrypoint for oasis-claw-runtime.
#
# 1. Ensure ~/.openclaw exists; mint a gateway auth token if not provided.
# 2. Run `openclaw plugins install --link --force` for each of our 10 baked-in
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

# ---- install our 10 extensions via the openclaw plugin registry --------
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
  [dot-swarm]=""
  [agent-primitives]=""
  [clawhub-skill-audit]=""
  [model-switcher]=""
  [oasis-voice]=""
  [browser]=""
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

# clawhub-skill-audit: Opus 4.7 security review on every newly installed skill,
# trail at ~/.openclaw/logs/skill-audits. ANTHROPIC_API_KEY is read by the
# plugin from env directly so we don't have to copy it into the JSON config.
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
if tg_token:
    skill_audit_cfg["telegramBotToken"] = tg_token
if tg_chat:
    skill_audit_cfg["telegramAlertChatId"] = tg_chat
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
oasis_voice_tts_voice = (
    os.environ.get("OASIS_VOICE_TTS_VOICE", "").strip() or "piper:en_US-lessac-high"
)
oasis_voice_cfg: dict = {
    "endpoint": oasis_voice_endpoint,
    "tts_voice": oasis_voice_tts_voice,
}
if oasis_voice_bearer:
    oasis_voice_cfg["bearer_token"] = oasis_voice_bearer
merge_config("oasis-voice", oasis_voice_cfg)

# ---- audio media-understanding routing (CLAW-021) ----------------------
# Telegram (and future iMessage) voice-message inbound: when a user sends
# a voice note, openclaw's media-understanding pipeline picks an audio
# provider to transcribe it. The valid config schema for this section is
# enumerated in vendor/openclaw-source/src/config/media-audio-field-metadata.ts
# — `tools.media.audio.provider` is NOT a valid key (which caused a config
# validation failure on the first boot of d081484). The right route is:
#   - Just enable the section: `tools.media.audio.enabled = true`
#   - Let provider selection happen via the registered providers'
#     autoPriority — our oasis-voice plugin sets
#     `autoPriority: { audio: 10 }` which ranks ahead of the cloud
#     providers (deepgram/google/groq at 20-30). So when oasis-voice is
#     reachable, it wins; if it's down, an explicitly-configured cloud
#     provider takes over.
#   - If we ever NEED to hard-force (e.g. cloud STT key is configured
#     but we still want local), add `tools.media.audio.models = [...]`
#     with our model id first. Not needed today.
config.setdefault("tools", {})
config["tools"].setdefault("media", {})
config["tools"]["media"].setdefault("audio", {})
config["tools"]["media"]["audio"]["enabled"] = True

# Provider baseUrl + apiKey hand-off. The openclaw
# MediaUnderstandingProvider framework reads these from
# `models.providers.<id>` and passes them to our `transcribeAudio`
# callback. Without them, the plugin falls back to its DEFAULT_ENDPOINT
# (http://127.0.0.1:8731) which is wrong inside the openclaw container
# (no sidecar at loopback); the docker-DNS name we set above is the
# right value.
config.setdefault("models", {})
config["models"].setdefault("providers", {})
config["models"]["providers"].setdefault("oasis-voice", {})
config["models"]["providers"]["oasis-voice"]["baseUrl"] = oasis_voice_endpoint
if oasis_voice_bearer:
    config["models"]["providers"]["oasis-voice"]["apiKey"] = oasis_voice_bearer

# ---- outbound voice (CLAW-021): voice-in → voice-out ------------------
# Three knobs together make this work:
#   1. `messages.tts.provider = "oasis-voice"` — when openclaw decides to
#      TTS a reply, it asks our SpeechProvider (not deepgram/elevenlabs/
#      anything else that may register later). This is the OUTBOUND
#      counterpart of the inbound `tools.media.audio.provider` pin above.
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
# Profile/download/trash dirs live on the persistent volume so user data
# (cookies, login state) survives a rebuild. Binary stays on the read-only
# image at $PLAYWRIGHT_BROWSERS_PATH=/opt/playwright.
browser_data_dir = home / ".openclaw/browser"
browser_data_dir.mkdir(parents=True, exist_ok=True)
config["browser"].setdefault("dataDir", str(browser_data_dir))

# ---- default LLM model (OPENCLAW_DEFAULT_MODEL env var) ----------------
# Set via .env + make recreate, or live via `openclaw config set` + make restart.
# Provider strings: "anthropic/claude-sonnet-4-6", "gemini/gemini-2.0-flash",
#   "openai/gpt-4o", "bedrock/anthropic.claude-sonnet-4-5-v1:0",
#   "ollama/llama3.3" (needs host.docker.internal reachable from container).
# Leave unset to keep whatever openclaw already has configured.
default_model = os.environ.get("OPENCLAW_DEFAULT_MODEL", "").strip() or None
if default_model:
    config.setdefault("agents", {})
    config["agents"].setdefault("defaults", {})
    config["agents"]["defaults"].setdefault("model", {})
    # Always reflect env — lets .env rotation change the active model on recreate.
    config["agents"]["defaults"]["model"]["primary"] = default_model
    print(f"[entrypoint] default model set to: {default_model}")

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
                    agent-primitives, clawhub-skill-audit,
                    model-switcher, oasis-voice, browser
   browser eval   : disabled (per CLAW-014 audit; per-session opt-in only)
   config file    : ${CONFIG_FILE}
==============================================================
BANNER

exec openclaw gateway --bind "${BIND}" --port "${PORT}"
