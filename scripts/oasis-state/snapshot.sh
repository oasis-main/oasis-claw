#!/usr/bin/env bash
# oasis-state snapshot.sh
#
# Bundle Nimbus's portable state into:
#   - <state-repo>/text/                         (plaintext, mergeable)
#   - <state-repo>/secrets.tar.age               (age-encrypted)
#   - <state-repo>/snapshots/<ts>/blob.manifest  (sha256, size, backends)
#   - rclone:<backend>:nimbus-state/blob/<ts>.tar.age  (encrypted blob, off-repo)
#
# Then commits & pushes the state repo. The blob does NOT go in git.
#
# Required on the host:
#   - docker (Desktop on Mac, native on Linux)
#   - the oasis_openclaw_home named volume populated by oasis-claw-runtime
#   - an rclone config at ${OASIS_STATE_RCLONE_CONFIG:-$HOME/.config/rclone/rclone.conf}
#     with remotes named in OASIS_STATE_BACKENDS (default: r2)
#   - an age recipients file at ${OASIS_STATE_AGE_RECIPIENTS:-$HOME/.config/oasis-state/recipients}
#     (one age public key per line). The matching private key lives at
#     ${OASIS_STATE_AGE_KEY:-$HOME/.config/oasis-state/age.key} — guarded
#     outside the state repo; restore.sh needs it.
#   - a git working tree at ${OASIS_STATE_REPO:-$HOME/.local/share/oasis-state/repo}
#     pointing at the nimbus-state git remote.
#
# Idempotent. Re-running on the same minute will overwrite that minute's
# snapshot. Use --dry-run to see what would be done.

set -euo pipefail

# ───────────────────────────── config ────────────────────────────────────────

CONTAINER="${OASIS_STATE_CONTAINER:-oasis-claw-runtime}"
VOLUME="${OASIS_STATE_VOLUME:-oasis_openclaw_home}"
IMAGE="${OASIS_STATE_IMAGE:-oasis-state:local}"
STATE_REPO="${OASIS_STATE_REPO:-$HOME/.local/share/oasis-state/repo}"
RCLONE_CONFIG="${OASIS_STATE_RCLONE_CONFIG:-$HOME/.config/rclone/rclone.conf}"
AGE_RECIPIENTS="${OASIS_STATE_AGE_RECIPIENTS:-$HOME/.config/oasis-state/recipients}"
BACKENDS="${OASIS_STATE_BACKENDS:-r2}"
RETAIN_DAILY="${OASIS_STATE_RETAIN_DAILY:-30}"
RETAIN_MONTHLY="${OASIS_STATE_RETAIN_MONTHLY:-12}"
DRY_RUN=0
PUSH_GIT=1

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --no-git-push) PUSH_GIT=0; shift ;;
    -h|--help)
      sed -n '2,40p' "${BASH_SOURCE[0]}"
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { printf '%s [snapshot] %s\n' "$(date -Iseconds)" "$*"; }
die() { log "ERROR: $*"; exit 1; }
run() { if [ "$DRY_RUN" = 1 ]; then echo "DRY: $*"; else "$@"; fi; }

# ───────────────────────────── preflight ─────────────────────────────────────

command -v docker >/dev/null || die "docker not found on PATH"
docker volume inspect "$VOLUME" >/dev/null 2>&1 || die "docker volume $VOLUME does not exist"
[ -f "$RCLONE_CONFIG" ] || die "rclone config not found at $RCLONE_CONFIG (run: rclone config)"
[ -f "$AGE_RECIPIENTS" ] || die "age recipients not found at $AGE_RECIPIENTS (see README)"
[ -d "$STATE_REPO/.git" ] || die "state repo not initialized at $STATE_REPO (see README setup)"

# Build the sidecar image if missing. Cheap when cached.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "building $IMAGE (first run; cached after this)"
  run docker build -t "$IMAGE" "$repo_root/scripts/oasis-state"
fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
day="$(date -u +%Y-%m-%d)"

# All non-trivial work happens inside the sidecar. The host only orchestrates.
# We mount:
#   - the openclaw volume read-only at /state-src
#   - the state repo at /state-repo
#   - rclone config at /home/state/.config/rclone (rclone honors this path)
#   - age recipients at /age-recipients (read-only)
#   - allowlists at /lists (read-only)
run docker run --rm \
  -e TS="$ts" \
  -e DAY="$day" \
  -e BACKENDS="$BACKENDS" \
  -e RETAIN_DAILY="$RETAIN_DAILY" \
  -e RETAIN_MONTHLY="$RETAIN_MONTHLY" \
  -v "${VOLUME}:/state-src:ro" \
  -v "${STATE_REPO}:/state-repo" \
  -v "${RCLONE_CONFIG}:/home/state/.config/rclone/rclone.conf:ro" \
  -v "${AGE_RECIPIENTS}:/age-recipients:ro" \
  -v "${repo_root}/scripts/oasis-state:/lists:ro" \
  "$IMAGE" /lists/snapshot-inner.sh

if [ "$PUSH_GIT" = 1 ] && [ "$DRY_RUN" = 0 ]; then
  log "committing state repo"
  (
    cd "$STATE_REPO"
    git add -A
    if ! git diff --cached --quiet; then
      git commit -m "snapshot $ts"
      git push
    else
      log "no text/secret changes to commit (blob still pushed to backends)"
    fi
  )
fi

log "done"
