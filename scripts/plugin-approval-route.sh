#!/bin/sh
# plugin-approval-route.sh — CLAW-116 (Mike, 2026-09-22): route plugin approval
# cards to Mike's Telegram chat, then start the normal runtime entrypoint.
#
# Why: the oasis-reviewer asks Mike with a native plugin approval card
# ({requireApproval}). openclaw delivers a card to the ORIGIN chat of the turn.
# A mail-woken turn (session key agent:main:hook:reach-<ts>) has no origin
# chat, so without a fixed target the card has no route and the call fails.
# openclaw's `approvals.plugin` forwarding with mode "targets" sends every
# plugin card to a fixed chat. Plugin-approval forwarding is independent of
# exec-approval forwarding (`approvals.exec`), which this does not touch.
#
# Used only where the compose overlay names it as the entrypoint (today:
# bots/docker-compose.yesman-reach.yml). Gated on OASIS_PLUGIN_APPROVAL_TARGET
# ("telegram"); unset → the config is left exactly as it is. The chat id is the
# operator id the entrypoint already uses (OASIS_TELEGRAM_CHAT_ID).
#
# openclaw.json persists on the bot volume and runtime-entrypoint.sh merges
# into it (it keeps keys it does not own), so this edit survives the merge.
# Written before the gateway starts — never a live edit (see the config-drift
# note in project memory: mutating openclaw.json under a running gateway
# breaks the next Telegram turn).
set -eu

if [ -n "${OASIS_PLUGIN_APPROVAL_TARGET:-}" ]; then
  python3 - <<'PY'
import json, os, sys
from pathlib import Path

channel = os.environ["OASIS_PLUGIN_APPROVAL_TARGET"].strip()
chat = os.environ.get("OASIS_TELEGRAM_CHAT_ID", "").strip()
path = Path(os.environ["HOME"]) / ".openclaw" / "openclaw.json"
if channel != "telegram" or not chat.lstrip("-").isdigit():
    print(f"[plugin-approval-route] skipped: target={channel!r}, chat id set={bool(chat)}", file=sys.stderr)
    sys.exit(0)
try:
    config = json.loads(path.read_text()) if path.exists() else {}
except json.JSONDecodeError:
    print("[plugin-approval-route] openclaw.json unreadable; left unchanged", file=sys.stderr)
    sys.exit(0)
want = {
    "enabled": True,
    "mode": "targets",
    "agentFilter": ["main"],
    "targets": [{"channel": "telegram", "to": chat}],
}
approvals = config.setdefault("approvals", {})
if approvals.get("plugin") != want:
    approvals["plugin"] = want
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2) + "\n")
    print("[plugin-approval-route] approvals.plugin → telegram operator chat (targets)")
else:
    print("[plugin-approval-route] approvals.plugin already set")
PY
fi

exec /usr/local/bin/runtime-entrypoint.sh "$@"
