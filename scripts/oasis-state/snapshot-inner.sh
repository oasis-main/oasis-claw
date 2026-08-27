#!/usr/bin/env bash
# shell-portability: linux-only  -- runs only inside the oasis-state sidecar
# (invoked by snapshot.sh via a container run), so the image bash 5 applies.
# Runs inside the oasis-state sidecar. Called by snapshot.sh — don't call
# directly. Reads from /state-src (openclaw volume, ro), writes to /state-repo
# and rclone remotes. Allowlists at /lists/*.list.

set -euo pipefail

: "${TS:?missing}"
: "${DAY:?missing}"
: "${BACKENDS:?missing}"
RETAIN_DAILY="${RETAIN_DAILY:-30}"
RETAIN_MONTHLY="${RETAIN_MONTHLY:-12}"

cd /state-src

log() { printf '%s [snapshot-inner] %s\n' "$(date -Iseconds)" "$*"; }

# ─── helpers ─────────────────────────────────────────────────────────────────

# Read a .list file → expand glob lines → emit matching paths, one per line.
# Skips comment lines and blanks. Globs are evaluated against /state-src cwd.
expand_list() {
  local list="$1"
  local pattern
  shopt -s globstar nullglob dotglob
  while IFS= read -r pattern; do
    case "$pattern" in ''|\#*) continue ;; esac
    # shellcheck disable=SC2206
    local matches=( $pattern )
    for m in "${matches[@]}"; do
      [ -e "$m" ] && echo "$m"
    done
  done < "$list"
  shopt -u globstar nullglob dotglob
}

# ─── (1) text bucket → /state-repo/text/ ─────────────────────────────────────

log "syncing text bucket"
rm -rf /state-repo/text
mkdir -p /state-repo/text
text_files="$(expand_list /lists/text.list)"
if [ -n "$text_files" ]; then
  # Use tar to preserve directory structure during copy.
  echo "$text_files" | tar -c -T - -f - | tar -x -C /state-repo/text -f -
  printf '%s\n' "$text_files" | wc -l | xargs -I{} log "text: {} files copied"
else
  log "text: nothing matched"
fi

# Redact .gateway-token-like fields from openclaw.json if present (defensive;
# the file shouldn't carry secrets, but channel tokens have crept in before).
if [ -f /state-repo/text/openclaw.json ]; then
  jq 'walk(if type == "object" then
            with_entries(if (.key | test("token|secret|apiKey"; "i")) and (.value | type == "string")
                        then .value = "<<REDACTED>>" else . end)
          else . end)' \
    /state-repo/text/openclaw.json > /state-repo/text/openclaw.json.tmp
  mv /state-repo/text/openclaw.json.tmp /state-repo/text/openclaw.json
fi

# ─── (2) secrets bucket → /state-repo/secrets.tar.age ────────────────────────

log "packing secrets bucket"
secrets_files="$(expand_list /lists/secrets.list)"
if [ -n "$secrets_files" ]; then
  recipient_args=()
  while IFS= read -r r; do
    case "$r" in ''|\#*) continue ;; esac
    recipient_args+=(-r "$r")
  done < /age-recipients
  [ ${#recipient_args[@]} -gt 0 ] || { log "no age recipients"; exit 1; }

  echo "$secrets_files" | tar -cz -T - -f - \
    | age "${recipient_args[@]}" -o /state-repo/secrets.tar.gz.age
  # Remove the legacy uncompressed name if it exists from a pre-compression run.
  rm -f /state-repo/secrets.tar.age
  log "secrets: $(echo "$secrets_files" | wc -l) files → $(stat -c %s /state-repo/secrets.tar.gz.age) bytes encrypted (gzip + age)"
else
  log "secrets: nothing matched (no secrets.tar.age written)"
fi

# ─── (3) blob bucket → tarball → age → rclone push ───────────────────────────

log "packing blob bucket"
blob_files="$(expand_list /lists/blob.list)"
mkdir -p /state-repo/snapshots/"$TS"
manifest="/state-repo/snapshots/$TS/blob.manifest.json"

if [ -n "$blob_files" ]; then
  recipient_args=()
  while IFS= read -r r; do
    case "$r" in ''|\#*) continue ;; esac
    recipient_args+=(-r "$r")
  done < /age-recipients

  blob_path="/tmp/blob.tar.gz.age"
  blob_uncompressed=$(echo "$blob_files" | tar -c -T - --sort=name -f - | wc -c)
  echo "$blob_files" | tar -cz -T - --sort=name -f - \
    | age "${recipient_args[@]}" -o "$blob_path"
  blob_sha="$(sha256sum "$blob_path" | awk '{print $1}')"
  blob_size="$(stat -c %s "$blob_path")"
  ratio=$(awk -v u="$blob_uncompressed" -v c="$blob_size" 'BEGIN{printf "%.1fx", u/c}')
  log "blob: $(echo "$blob_files" | wc -l) entries → $blob_size bytes encrypted (gzip + age, $ratio compression, sha256 $blob_sha)"

  # Push to each backend in OASIS_STATE_BACKENDS (comma-separated).
  pushed_to=()
  IFS=',' read -ra backend_list <<< "$BACKENDS"
  for backend in "${backend_list[@]}"; do
    backend="$(echo "$backend" | xargs)"  # trim
    [ -z "$backend" ] && continue
    target="${backend}:nimbus-state/blob/${TS}.tar.gz.age"
    log "pushing → $target"
    rclone copyto "$blob_path" "$target" --progress=false --stats=0
    pushed_to+=("$backend")

    # Retention sweep: keep last RETAIN_DAILY snapshots; preserve first-of-month
    # snapshots beyond that for RETAIN_MONTHLY months. Implemented as: list,
    # sort desc, decide keep/delete per entry.
    rclone lsf "${backend}:nimbus-state/blob/" --files-only 2>/dev/null \
      | sort -r > /tmp/snaps.list
    kept_daily=0
    declare -A kept_months=()
    while IFS= read -r snap; do
      [ -z "$snap" ] && continue
      # snap looks like 20260622T180000Z.tar.gz.age
      snap_ts="${snap%.tar.gz.age}"
      snap_month="${snap_ts:0:6}"  # YYYYMM
      if [ "$kept_daily" -lt "$RETAIN_DAILY" ]; then
        kept_daily=$((kept_daily + 1))
        continue
      fi
      if [ -z "${kept_months[$snap_month]:-}" ] \
         && [ "${#kept_months[@]}" -lt "$RETAIN_MONTHLY" ]; then
        kept_months[$snap_month]=1
        continue
      fi
      log "  retention: deleting $backend:$snap"
      rclone deletefile "${backend}:nimbus-state/blob/${snap}" --stats=0 || true
    done < /tmp/snaps.list
  done

  jq -n \
    --arg ts "$TS" \
    --arg sha "$blob_sha" \
    --argjson size "$blob_size" \
    --argjson files "$(echo "$blob_files" | wc -l)" \
    --argjson backends "$(printf '%s\n' "${pushed_to[@]}" | jq -R . | jq -s .)" \
    '{ts: $ts, sha256: $sha, sizeBytes: $size, fileCount: $files, backends: $backends}' \
    > "$manifest"
  log "blob manifest → $manifest"
  rm -f "$blob_path"
else
  log "blob: nothing matched (no blob written)"
  echo '{"ts":"'"$TS"'","empty":true}' > "$manifest"
fi

# ─── (4) prune in-repo snapshot manifests (same retention) ───────────────────

# The git repo accumulates one snapshots/<ts>/blob.manifest.json per run. Apply
# the same retention as the blob backends.
if [ -d /state-repo/snapshots ]; then
  ls -1 /state-repo/snapshots | sort -r > /tmp/repo-snaps.list
  kept_daily=0
  declare -A kept_months=()
  while IFS= read -r snap; do
    [ -z "$snap" ] && continue
    snap_month="${snap:0:6}"
    if [ "$kept_daily" -lt "$RETAIN_DAILY" ]; then
      kept_daily=$((kept_daily + 1))
      continue
    fi
    if [ -z "${kept_months[$snap_month]:-}" ] \
       && [ "${#kept_months[@]}" -lt "$RETAIN_MONTHLY" ]; then
      kept_months[$snap_month]=1
      continue
    fi
    rm -rf "/state-repo/snapshots/${snap}"
  done < /tmp/repo-snaps.list
fi

log "snapshot-inner complete"
