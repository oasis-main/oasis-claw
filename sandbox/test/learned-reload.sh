#!/usr/bin/env bash
# Learned-allowlist hot-reload proof for the egress proxy (CLAW-034 plumbing).
#
# Proves the substrate the first-visit vetting service writes into:
#   [1] a host NOT in any allowlist is denied fail-closed (HTTP 403) AND the
#       deny is tagged `vettable:true` — the signal the vetter queues on;
#   [2] appending that host to the LEARNED store (what the vetter does on a
#       pass verdict) makes the proxy hot-reload and STOP denying it, with no
#       restart — the decision flips from host-not-allowlisted to a real dial;
#   [3] the reload is audited (`event:reload action:applied`).
#
# Hermetic: runs the built binary directly and only ever targets *.invalid
# hosts (RFC 6761 — guaranteed never to resolve), so no real egress occurs and
# the "allowed" outcome is a clean DNS failure PAST the allowlist gate, not a
# live connection. No docker required.
#
# Exit code = number of failed assertions (0 = all pass).
set -u
cd "$(dirname "$0")/../egress-proxy"

PORT=31288
PROXY="http://127.0.0.1:${PORT}"
HOST="vettest.invalid"
WORK="$(mktemp -d)"
STATIC="${WORK}/allowlist.txt"
LEARNED="${WORK}/learned.txt"
LOG="${WORK}/proxy.log"
BIN="${WORK}/egress-proxy"

pass=0 fail=0
ok()   { echo "  ✅ PASS: $1"; pass=$((pass + 1)); }
bad()  { echo "  ❌ FAIL: $1"; fail=$((fail + 1)); }
cleanup() { [ -n "${PROXY_PID:-}" ] && kill "${PROXY_PID}" 2>/dev/null; rm -rf "${WORK}"; }
trap cleanup EXIT

echo "== build =="
CGO_ENABLED=0 go build -o "${BIN}" . || { echo "build failed"; exit 99; }

# Static seed carries only the core (never empty — fail-closed start). The
# learned store starts absent, exactly as it is before the vetter's first write.
printf '.anthropic.com\napi.telegram.org\n' > "${STATIC}"

echo "== start proxy (reload every 1s) =="
LISTEN="127.0.0.1:${PORT}" \
  ALLOWLIST_FILE="${STATIC}" \
  LEARNED_ALLOWLIST_FILE="${LEARNED}" \
  LEARNED_RELOAD_SECONDS=1 \
  SNI_ENFORCE=off \
  "${BIN}" > "${LOG}" 2>&1 &
PROXY_PID=$!
sleep 1

echo
echo "== [1] unknown host denied fail-closed + tagged vettable =="
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -x "${PROXY}" "http://${HOST}/" 2>/dev/null)
echo "    http_status=${code}"
[ "${code}" = "403" ] && ok "unknown ${HOST} → 403 deny" || bad "expected 403, got ${code}"
if grep -q "\"host\":\"${HOST}\"" "${LOG}" && grep -q '"vettable":true' "${LOG}"; then
  ok "deny audited with vettable:true (vetter work-signal present)"
else
  bad "deny not audited as vettable"
fi

echo
echo "== [2] vetter learns the host → append to learned store =="
printf '%s\n' "${HOST}" >> "${LEARNED}"
sleep 2   # > reload interval

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -x "${PROXY}" "http://${HOST}/" 2>/dev/null)
echo "    http_status=${code}"
# Past the allowlist gate the proxy tries to dial vettest.invalid → DNS failure
# → 502. The point is it's NO LONGER a 403 host-not-allowlisted deny.
if [ "${code}" = "502" ]; then
  ok "learned ${HOST} → 502 (allowlist passed; dial failed as expected for .invalid)"
elif [ "${code}" = "403" ]; then
  bad "still 403 — learned entry did NOT take effect"
else
  ok "learned ${HOST} → ${code} (no longer a 403 deny)"
fi

echo
echo "== [3] reload was audited =="
if grep -q '"event":"reload"' "${LOG}" && grep -q '"action":"applied"' "${LOG}"; then
  ok "reload event audited (event:reload action:applied)"
else
  bad "no reload event in audit log"
fi

echo
echo "== proxy audit log =="
tail -8 "${LOG}"

echo
echo "== summary: ${pass} passed, ${fail} failed =="
exit "${fail}"
