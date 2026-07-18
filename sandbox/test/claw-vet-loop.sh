#!/usr/bin/env bash
# claw-vet ↔ egress-proxy integration proof (CLAW-034).
#
# Proves the vetting brain closes the loop with the sandbox substrate:
#   [1] a host the proxy denies (vettable) is unreachable;
#   [2] `claw-vet run <host> --dry-run` (stubbed classifier) writes it to the
#       learned store — claw-vet is the sole writer;
#   [3] the proxy hot-reloads that write and STOPS denying it, no restart.
#
# Hermetic: runs the proxy binary directly against a *.invalid host (RFC 6761 —
# never resolves) with a temp learned dir. --dry-run skips the live gateway, so
# this needs neither docker nor oasis-generation. The live classifier + honeypot
# meta-eval are validated separately (they need the gateway + a token).
#
# Exit code = number of failed assertions (0 = all pass).
set -u
cd "$(dirname "$0")/../.."   # repo root

PORT=31290
PROXY="http://127.0.0.1:${PORT}"
HOST="clawvet-regression.invalid"
WORK="$(mktemp -d)"
STATIC="${WORK}/allowlist.txt"
LEARNED="${WORK}/learned"
BIN="${WORK}/egress-proxy"
LOG="${WORK}/proxy.log"

pass=0 fail=0
ok()  { echo "  ✅ PASS: $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ FAIL: $1"; fail=$((fail + 1)); }
cleanup() { [ -n "${PROXY_PID:-}" ] && kill "${PROXY_PID}" 2>/dev/null; rm -rf "${WORK}"; }
trap cleanup EXIT

mkdir -p "${LEARNED}"
printf '.anthropic.com\napi.telegram.org\n' > "${STATIC}"

echo "== build proxy =="
( cd sandbox/egress-proxy && CGO_ENABLED=0 go build -o "${BIN}" . ) || { echo "build failed"; exit 99; }

echo "== start proxy (reload 1s) =="
LISTEN="127.0.0.1:${PORT}" ALLOWLIST_FILE="${STATIC}" \
  LEARNED_ALLOWLIST_FILE="${LEARNED}/allowlist.txt" \
  LEARNED_RELOAD_SECONDS=1 SNI_ENFORCE=off \
  "${BIN}" > "${LOG}" 2>&1 &
PROXY_PID=$!
sleep 1

echo
echo "== [1] host denied before vetting =="
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -x "${PROXY}" "http://${HOST}/" 2>/dev/null)
[ "${c}" = "403" ] && ok "unvetted ${HOST} → 403" || bad "expected 403, got ${c}"

echo
echo "== [2] claw-vet writes the learned store (dry-run) =="
# OASIS_EGRESS_PROXY points at a container that does not exist ON PURPOSE. This
# test runs its own proxy binary against a temp learned dir, but claw-vet's
# role-policy gate asks the named container whether it is partitioned — against
# the default name that is the LIVE fleet proxy, which would make a "hermetic"
# test depend on production state (and fail this global-scope write with
# `unattributed-candidate`). An unreachable container yields "unknown", which the
# gate treats as not-partitioned-enough-to-refuse — the correct reading here.
out=$(OASIS_EGRESS_LEARNED_DIR="${LEARNED}" OASIS_EGRESS_PROXY="clawvet-test-noproxy" \
      python3 scripts/claw-vet run "${HOST}" --dry-run --json 2>&1)
echo "    ${out}"
echo "${out}" | grep -q '"decision": "allow"' && ok "claw-vet allowed + wrote learned store" || bad "claw-vet did not allow"
grep -qx "${HOST}" "${LEARNED}/allowlist.txt" 2>/dev/null && ok "host present in allowlist.txt" || bad "host not written to allowlist.txt"

echo
echo "== [3] proxy hot-reloads claw-vet's write =="
sleep 2
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -x "${PROXY}" "http://${HOST}/" 2>/dev/null)
if [ "${c}" = "502" ]; then ok "vetted ${HOST} → 502 (past the gate; dial fails for .invalid)"
elif [ "${c}" = "403" ]; then bad "still 403 — learned write did not take effect"
else ok "vetted ${HOST} → ${c} (no longer a 403 deny)"; fi

echo
echo "== summary: ${pass} passed, ${fail} failed =="
exit "${fail}"
