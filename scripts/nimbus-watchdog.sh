#!/usr/bin/env bash
# nimbus-watchdog.sh
#
# ██ RETIRED 2026-07-26 (CLAW-073). NOT DEPLOYED — launchd job + plist + the
# ██ Application-Support copy were all removed. Root cause of the "polling
# ██ stalls" this chased turned out to be macOS Maintenance Sleep suspending the
# ██ Docker VM (each "stuck for" duration == a `pmset -g log` sleep duration),
# ██ NOT an openclaw defect — openclaw self-recovers on wake. This watchdog was
# ██ issuing SPURIOUS `docker restart`s that raced that recovery (~daily on
# ██ Nimbus), and the 300s→90s interval made it worse. Kept in-repo (not run)
# ██ for the macOS-TCC + sleep/wake learnings in the header below. To ever
# ██ re-enable, `make watchdog-install` — but don't, without a new reason.
#
# Detect and recover from the openclaw Telegram polling channel silently dying
# after a stop-timeout. Common trigger on this host is macOS sleep wedging the
# undici keep-alive socket (a stuck getUpdates long-poll + a channel stop that
# cannot close the dead socket).
#
# CORRECTION 2026-07-25 (CLAW-073): this header used to claim the root bug was
# "server-channels.ts sets restartPending:true after a stop-after-abort timeout but
# nothing consumes it." That is STALE — it described openclaw <=2026.4.26. Upstream
# fixed it by 2026.5.6 (present in our deployed 6.11): the task-exit handler drives
# the restart and uses the `recoveryStopTimedOut` set to run the backoff sleep on a
# FRESH AbortController, precisely because the original signal is already aborted
# after a stop-timeout. `restartPending` is a status/readiness flag, not a work
# queue. openclaw's own recovery (auto-restart attempts + the polling stall monitor,
# default 120s) therefore DOES work. This watchdog remains the belt-and-suspenders
# backstop for the cases it doesn't cover (e.g. attempts exhausted, or a wedge that
# outlives openclaw's own retries) and for fleet-wide fast recovery.
#
# FLEET-WIDE (2026-07-25): the stall is systemic — every bot logs ~9-10 stall/stop
# events/day, not just Nimbus. So this watches ALL bot containers, not one. For each
# wedged container it issues `docker restart`. Healthy operation is silent.
#
# Container selection (first match wins):
#   NIMBUS_WATCHDOG_CONTAINERS  — explicit space-separated list, OR
#   NIMBUS_WATCHDOG_CONTAINER   — single container (back-compat), OR
#   (default) auto-discover running `oasis-claw-*` bot containers (excludes the
#             `-vet` helper; sidecars egress-proxy/voice/semantics are not
#             `oasis-claw-` prefixed so they are excluded naturally).
#
# Idempotent and safe to re-run. Deployed OUTSIDE ~/Documents (macOS TCC blocks
# launchd from reading Documents → exit 126, silently) via `make watchdog-install`;
# re-run that after editing this file.

set -euo pipefail

WATCH_WINDOW_MIN="${NIMBUS_WATCHDOG_WINDOW_MIN:-10}"
LOG_FILE="${NIMBUS_WATCHDOG_LOG:-$HOME/Library/Logs/nimbus-watchdog.log}"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  printf '%s [watchdog] %s\n' "$(date -Iseconds)" "$*" >>"$LOG_FILE"
}

# Resolve the container list.
if [ -n "${NIMBUS_WATCHDOG_CONTAINERS:-}" ]; then
  containers="$NIMBUS_WATCHDOG_CONTAINERS"
elif [ -n "${NIMBUS_WATCHDOG_CONTAINER:-}" ]; then
  containers="$NIMBUS_WATCHDOG_CONTAINER"
else
  containers="$(docker ps --format '{{.Names}}' 2>/dev/null \
    | grep -E '^oasis-claw-' | grep -vE -- '-vet$' | sort || true)"
fi

[ -z "$containers" ] && exit 0

check_one() {
  container="$1"

  if ! docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -qx true; then
    return 0  # not running; nothing to do (silent — expected for stopped bots)
  fi

  logs="$(docker logs --since "${WATCH_WINDOW_MIN}m" "$container" 2>&1 || true)"

  # Most recent death marker timestamp (ISO8601 from openclaw log prefix).
  last_death="$({ printf '%s\n' "$logs" \
    | grep -E 'channel stop exceeded|Polling runner stop timed out|Polling stall detected' \
    || true; } | tail -1 | awk '{print $1}')"

  [ -z "$last_death" ] && return 0

  # Most recent recovery marker timestamp.
  last_recovery="$({ printf '%s\n' "$logs" \
    | grep -E '\[telegram\] \[default\] starting provider' \
    || true; } | tail -1 | awk '{print $1}')"

  # String comparison is correct: both are fixed-width ISO8601.
  if [ -n "$last_recovery" ] && [ "$last_recovery" \> "$last_death" ]; then
    return 0  # recovered after the death; healthy (silent)
  fi

  log "$container: telegram channel wedged (last death=$last_death, no recovery since); restarting"
  docker restart "$container" >>"$LOG_FILE" 2>&1 || log "$container: restart FAILED"
  log "$container: restart issued"
}

for c in $containers; do
  check_one "$c"
done
