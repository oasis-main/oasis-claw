#!/usr/bin/env bash
# Inner half of restore.sh. Runs in the sidecar. Reads from /state-repo,
# fetches blob from rclone backend, decrypts with /age-key, writes to
# /state-dst (the openclaw volume).

set -euo pipefail

: "${BACKENDS:?missing}"
TS="${TS:-}"

log() { printf '%s [restore-inner] %s\n' "$(date -Iseconds)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

# ─── (1) figure out which snapshot to restore ─────────────────────────────────

if [ -z "$TS" ]; then
  TS="$(ls -1 /state-repo/snapshots 2>/dev/null | sort | tail -1)"
  [ -n "$TS" ] || die "no snapshots/ entries in state repo; pass --ts <TS>"
  log "no --ts given; using latest: $TS"
fi
manifest="/state-repo/snapshots/$TS/blob.manifest.json"
[ -f "$manifest" ] || die "no manifest at $manifest"

if jq -e '.empty == true' "$manifest" >/dev/null 2>&1; then
  log "manifest marks snapshot $TS as empty (no blob to restore); text+secrets only"
  blob_expected_sha=""
else
  blob_expected_sha="$(jq -r .sha256 "$manifest")"
fi

# ─── (2) restore text bucket ──────────────────────────────────────────────────

if [ -d /state-repo/text ]; then
  log "restoring text bucket"
  # Preserve directory structure under /state-repo/text and recreate it under
  # /state-dst. Existing files at the destination are OVERWRITTEN.
  (cd /state-repo/text && tar -c -f - .) | (cd /state-dst && tar -x -f -)
  log "text bucket restored"
else
  log "no text/ in state repo; skipping"
fi

# ─── (3) restore secrets bucket ───────────────────────────────────────────────

if [ -f /state-repo/secrets.tar.gz.age ]; then
  log "restoring secrets bucket"
  age -d -i /age-key /state-repo/secrets.tar.gz.age | tar -xz -C /state-dst
  log "secrets bucket restored"
elif [ -f /state-repo/secrets.tar.age ]; then
  # Legacy path: snapshots taken before gzip was added are still readable.
  log "restoring secrets bucket (legacy uncompressed)"
  age -d -i /age-key /state-repo/secrets.tar.age | tar -x -C /state-dst
  log "secrets bucket restored"
else
  log "no secrets bucket in state repo; skipping"
fi

# ─── (4) restore blob from rclone ─────────────────────────────────────────────

if [ -n "$blob_expected_sha" ]; then
  IFS=',' read -ra backend_list <<< "$BACKENDS"
  fetched=0
  # Try the gzipped name first, fall back to the legacy uncompressed name for
  # snapshots that predate compression.
  for ext in tar.gz.age tar.age; do
    blob_path="/tmp/blob.${ext}"
    for backend in "${backend_list[@]}"; do
      backend="$(echo "$backend" | xargs)"
      [ -z "$backend" ] && continue
      src="${backend}:nimbus-state/blob/${TS}.${ext}"
      log "fetching ← $src"
      if rclone copyto "$src" "$blob_path" --progress=false --stats=0 2>/dev/null; then
        fetched=1
        break 2
      fi
    done
  done
  [ "$fetched" = 1 ] || die "could not fetch $TS blob from any backend"

  actual_sha="$(sha256sum "$blob_path" | awk '{print $1}')"
  [ "$actual_sha" = "$blob_expected_sha" ] \
    || die "sha256 mismatch: manifest says $blob_expected_sha, got $actual_sha"
  log "sha256 verified"

  if [[ "$blob_path" == *.tar.gz.age ]]; then
    age -d -i /age-key "$blob_path" | tar -xz -C /state-dst
  else
    age -d -i /age-key "$blob_path" | tar -x -C /state-dst
  fi
  log "blob restored"
  rm -f "$blob_path"
fi

log "restore-inner complete"
