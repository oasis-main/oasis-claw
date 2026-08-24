#!/usr/bin/env bash
# rebuild-oasis-voice.sh
#
# Rebuild the oasis-voice:cpu image from the vendored submodule, restart the
# sidecar via compose, repair the persistent named volume's permissions (the
# Dockerfile fix in vendor/oasis-voice@9ac224c only takes effect for *fresh*
# volumes — pre-existing ones keep their root:755 perms), and smoke-test TTS
# from inside the openclaw container (the sidecar has no host port).
#
# Idempotent. Safe to re-run.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repo_root}/docker-compose.runtime.yml"
voice_dir="${repo_root}/vendor/oasis-voice"

# DUAL-HOMING (fixed 2026-08-24). docker-compose.runtime.yml attaches oasis-voice
# to oasis_runtime ONLY. sandbox/docker-compose.sandbox-runtime.yml re-declares the
# same service on BOTH oasis_runtime and oasis_sandboxed, and that second network
# is the only way the five sandboxed bots (house, kolmogorov, yesman, butterbolt,
# vanhelsing) resolve the hostname. Recreating the sidecar from the runtime file
# alone silently drops it back to oasis_runtime — no error, no warning — and every
# sandboxed bot loses voice until someone notices. This is the same trap the root
# Makefile documents under "DUAL-HOMED SIDECAR TRAP".
# Layer the sandbox overlay whenever it exists so the attachment survives.
sandbox_file="${repo_root}/sandbox/docker-compose.sandbox-runtime.yml"
compose_args=(-f "${compose_file}")
if [[ -f "${sandbox_file}" ]]; then
  compose_args+=(-f "${sandbox_file}")
fi

note()  { printf "\033[1;34m[rebuild]\033[0m %s\n" "$*"; }
ok()    { printf "\033[1;32m[ ok ]\033[0m %s\n" "$*"; }
fail()  { printf "\033[1;31m[fail]\033[0m %s\n" "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker not on PATH"
[[ -f "${compose_file}" ]] || fail "compose file not found: ${compose_file}"
[[ -f "${voice_dir}/docker/Dockerfile.cpu" ]] || fail "Dockerfile.cpu not found under ${voice_dir}"

note "Building oasis-voice:cpu from ${voice_dir}"
( cd "${voice_dir}" && docker build -f docker/Dockerfile.cpu -t oasis-voice:cpu . )
ok "image built"

note "Recreating sidecar container"
docker compose "${compose_args[@]}" up -d --no-deps oasis-voice
ok "container up"

# Prove the dual-homing survived. A sidecar on oasis_runtime alone is the exact
# silent failure this script used to cause, so assert instead of assuming.
if [[ -f "${sandbox_file}" ]]; then
  note "Verifying oasis_sandboxed attachment"
  nets="$(docker inspect oasis-voice --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
  case "${nets}" in
    *oasis_sandboxed*) ok "dual-homed: ${nets}" ;;
    *) fail "oasis-voice is on '${nets}' with no oasis_sandboxed attachment — the five sandboxed bots have just lost voice. Restore with: cd bots && make sidecars-up" ;;
  esac
fi

note "Waiting for container to be running"
for i in {1..20}; do
  state="$(docker inspect -f '{{.State.Status}}' oasis-voice 2>/dev/null || echo missing)"
  [[ "${state}" == "running" ]] && break
  sleep 0.5
done
[[ "${state}" == "running" ]] || fail "oasis-voice not running (state=${state}); check 'docker logs oasis-voice'"
ok "container running"

# Repair the persistent volume's perms. Harmless if already correct.
# cap_drop: ALL means chown is blocked, but chmod from --user root works
# because the container's root maps through to the host volume metadata.
note "Repairing /srv/weights permissions on the named volume"
docker exec --user root oasis-voice sh -c '
  set -e
  chmod 1777 /srv/weights
  mkdir -p /srv/weights/huggingface /srv/weights/oasis-voice/piper
  chmod 777 /srv/weights/huggingface /srv/weights/oasis-voice /srv/weights/oasis-voice/piper
'
ok "weights perms repaired"

# Healthz before warmup. tts_loaded should be false here — that's expected,
# the sidecar lazy-loads on first request when VOICE_SKIP_WARMUP=1.
note "Pre-warmup /healthz"
docker exec oasis-claw-runtime sh -c \
  'curl -fsS http://oasis-voice:8731/healthz' || fail "healthz unreachable from openclaw"
echo

# Smoke TTS call. First hit downloads the Piper voice (~60s on a cold volume),
# so allow 120s. -f makes curl exit non-zero on HTTP 5xx so we can fail loudly.
note "Smoke TTS call (first hit may download voice — allow ~60s)"
docker exec oasis-claw-runtime sh -c '
  set -e
  rm -f /tmp/tts-smoke.wav
  curl -fsS --max-time 120 http://oasis-voice:8731/v1/tts/speak \
    -X POST -H "Content-Type: application/json" \
    -d "{\"text\":\"Rebuild smoke test. Hello from Aru.\",\"voice\":\"piper:en_GB-aru-medium\"}" \
    -o /tmp/tts-smoke.wav
  file /tmp/tts-smoke.wav
  bytes=$(stat -c %s /tmp/tts-smoke.wav 2>/dev/null || stat -f %z /tmp/tts-smoke.wav)
  echo "wav bytes: $bytes"
  [ "$bytes" -gt 1000 ] || { echo "WAV too small ($bytes bytes) — TTS likely produced silence"; exit 1; }
'
ok "TTS produced a non-empty WAV"

note "Post-warmup /healthz"
docker exec oasis-claw-runtime sh -c \
  'curl -fsS http://oasis-voice:8731/healthz'
echo

ok "oasis-voice rebuilt and healthy"
