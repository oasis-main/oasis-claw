#!/usr/bin/env bash
# oasis-state restore.sh
#
# Reverse of snapshot.sh. Pulls latest (or specified) snapshot from a backend,
# decrypts with the local age key, and writes into the oasis_openclaw_home
# docker volume. Intended for fresh-host migration:
#
#   1. Stand up oasis-claw-runtime once so the named volume is created
#      (`docker compose -f docker-compose.runtime.yml up --no-start openclaw`).
#   2. Stop it: `docker compose -f docker-compose.runtime.yml stop openclaw`.
#   3. Run this.
#   4. Bring oasis-claw-runtime up: `docker compose ... up -d`.
#
# Refuses to run if the container is RUNNING — restoring under a live
# runtime would corrupt sqlite WALs and confuse the session writer.

set -euo pipefail

CONTAINER="${OASIS_STATE_CONTAINER:-oasis-claw-runtime}"
VOLUME="${OASIS_STATE_VOLUME:-oasis_openclaw_home}"
IMAGE="${OASIS_STATE_IMAGE:-oasis-state:local}"
STATE_REPO="${OASIS_STATE_REPO:-$HOME/.local/share/oasis-state/repo}"
RCLONE_CONFIG="${OASIS_STATE_RCLONE_CONFIG:-$HOME/.config/rclone/rclone.conf}"
AGE_KEY="${OASIS_STATE_AGE_KEY:-$HOME/.config/oasis-state/age.key}"
BACKENDS="${OASIS_STATE_BACKENDS:-r2}"
TS=""

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --ts) TS="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "${BASH_SOURCE[0]}"
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { printf '%s [restore] %s\n' "$(date -Iseconds)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

# ─── preflight ───────────────────────────────────────────────────────────────

[ -f "$RCLONE_CONFIG" ] || die "rclone config not found at $RCLONE_CONFIG"
[ -f "$AGE_KEY" ] || die "age private key not found at $AGE_KEY"
[ -d "$STATE_REPO/.git" ] || die "state repo not initialized at $STATE_REPO"

if docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true; then
  die "$CONTAINER is RUNNING. Stop it first (\`docker stop $CONTAINER\`) before restoring."
fi

docker volume inspect "$VOLUME" >/dev/null 2>&1 \
  || die "docker volume $VOLUME doesn't exist. Run \`docker compose -f docker-compose.runtime.yml up --no-start openclaw\` to create it."

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "building $IMAGE"
  docker build -t "$IMAGE" "$repo_root/scripts/oasis-state"
fi

(cd "$STATE_REPO" && git pull --ff-only)

# ─── delegate to inner ───────────────────────────────────────────────────────

docker run --rm \
  -e TS="$TS" \
  -e BACKENDS="$BACKENDS" \
  -v "${VOLUME}:/state-dst" \
  -v "${STATE_REPO}:/state-repo:ro" \
  -v "${RCLONE_CONFIG}:/home/state/.config/rclone/rclone.conf:ro" \
  -v "${AGE_KEY}:/age-key:ro" \
  -v "${repo_root}/scripts/oasis-state:/lists:ro" \
  "$IMAGE" /lists/restore-inner.sh

log "done. Start oasis-claw-runtime: docker compose -f docker-compose.runtime.yml up -d"
