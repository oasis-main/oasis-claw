#!/usr/bin/env bash
# rebuild-oasis-semantics.sh
#
# Rebuild the oasis-semantics:cpu image from vendor/oasis-semantics, restart
# the sidecar via compose, repair the persistent weights volume's permissions,
# and smoke-test the /api/embed endpoint from inside the openclaw container
# (the sidecar has no host port).
#
# First run downloads bge-small-en-v1.5 (~130MB) on the initial embed call.
# Idempotent. Safe to re-run.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repo_root}/docker-compose.runtime.yml"
sem_dir="${repo_root}/vendor/oasis-semantics"

note()  { printf "\033[1;34m[rebuild]\033[0m %s\n" "$*"; }
ok()    { printf "\033[1;32m[ ok ]\033[0m %s\n" "$*"; }
fail()  { printf "\033[1;31m[fail]\033[0m %s\n" "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker not on PATH"
[[ -f "${compose_file}" ]] || fail "compose file not found: ${compose_file}"
[[ -f "${sem_dir}/docker/Dockerfile.cpu" ]] || fail "Dockerfile.cpu not found under ${sem_dir}"

note "Building oasis-semantics:cpu from ${sem_dir}"
( cd "${sem_dir}" && docker build -f docker/Dockerfile.cpu -t oasis-semantics:cpu . )
ok "image built"

note "Recreating sidecar container"
docker compose -f "${compose_file}" up -d --no-deps oasis-semantics
ok "container up"

note "Waiting for container to be running"
for i in {1..20}; do
  state="$(docker inspect -f '{{.State.Status}}' oasis-semantics 2>/dev/null || echo missing)"
  [[ "${state}" == "running" ]] && break
  sleep 0.5
done
[[ "${state}" == "running" ]] || fail "oasis-semantics not running (state=${state}); check 'docker logs oasis-semantics'"
ok "container running"

note "Repairing /srv/weights permissions on the named volume"
docker exec --user root oasis-semantics sh -c '
  set -e
  chmod 1777 /srv/weights
  mkdir -p /srv/weights/huggingface /srv/weights/oasis-semantics
  chmod 777 /srv/weights/huggingface /srv/weights/oasis-semantics
'
ok "weights perms repaired"

note "Pre-warmup /healthz"
docker exec oasis-claw-runtime sh -c \
  'curl -fsS http://oasis-semantics:8732/healthz' || fail "healthz unreachable from openclaw"
echo

note "Smoke embed call (first hit downloads bge-small — allow ~120s)"
docker exec oasis-claw-runtime sh -c '
  set -e
  result=$(curl -fsS --max-time 120 http://oasis-semantics:8732/api/embed \
    -X POST -H "Content-Type: application/json" \
    -d "{\"model\":\"default\",\"input\":[\"hello world\"]}")
  dim=$(echo "$result" | python3 -c "import sys,json; print(len(json.load(sys.stdin)[\"embeddings\"][0]))" 2>/dev/null || echo "?")
  echo "embedding dim: $dim"
  [ "$dim" = "384" ] || { echo "expected 384-d from bge-small, got $dim"; exit 1; }
'
ok "text embedding returned 384-d vector"

note "/v1/tiers"
docker exec oasis-claw-runtime sh -c \
  'curl -fsS http://oasis-semantics:8732/v1/tiers' | python3 -m json.tool 2>/dev/null || true
echo

ok "oasis-semantics rebuilt and healthy"
