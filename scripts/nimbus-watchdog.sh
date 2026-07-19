#!/usr/bin/env bash
# nimbus-watchdog.sh
#
# Detect and recover from the openclaw Telegram polling channel silently dying
# after a stop-timeout. Root bug: vendor/openclaw-source/src/gateway/server-channels.ts
# marks the channel `restartPending: true` after a stop-after-abort timeout, but
# nothing consumes that flag, so the channel stays down indefinitely. Common
# trigger on this host is macOS sleep wedging the undici keep-alive socket.
#
# Strategy: if a known death-marker log line appears within WATCH_WINDOW_MIN
# and no `starting provider` line has appeared since, restart the runtime
# container. Healthy operation is silent — no false positives from quiet
# windows alone. Idempotent and safe to re-run.

set -euo pipefail

CONTAINER="${NIMBUS_WATCHDOG_CONTAINER:-oasis-claw-runtime}"
WATCH_WINDOW_MIN="${NIMBUS_WATCHDOG_WINDOW_MIN:-10}"
LOG_FILE="${NIMBUS_WATCHDOG_LOG:-$HOME/Library/Logs/nimbus-watchdog.log}"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  printf '%s [watchdog] %s\n' "$(date -Iseconds)" "$*" >>"$LOG_FILE"
}

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true; then
  log "container $CONTAINER not running; nothing to do"
  exit 0
fi

logs="$(docker logs --since "${WATCH_WINDOW_MIN}m" "$CONTAINER" 2>&1 || true)"

# Most recent death marker timestamp (ISO8601 from openclaw log prefix).
# `|| true` so set -o pipefail tolerates grep finding nothing.
last_death="$({ printf '%s\n' "$logs" \
  | grep -E 'channel stop exceeded|Polling runner stop timed out|Polling stall detected' \
  || true; } | tail -1 | awk '{print $1}')"

# Most recent recovery marker timestamp.
last_recovery="$({ printf '%s\n' "$logs" \
  | grep -E '\[telegram\] \[default\] starting provider' \
  || true; } | tail -1 | awk '{print $1}')"

if [ -z "$last_death" ]; then
  exit 0
fi

# String comparison is correct because both are ISO8601 with identical width.
if [ -n "$last_recovery" ] && [ "$last_recovery" \> "$last_death" ]; then
  log "death marker at $last_death superseded by recovery at $last_recovery; healthy"
  exit 0
fi

log "telegram channel wedged (last death=$last_death, no recovery since); restarting $CONTAINER"
docker restart "$CONTAINER" >>"$LOG_FILE" 2>&1
log "restart issued"
