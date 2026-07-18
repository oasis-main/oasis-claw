#!/usr/bin/env bash
# CLAW-050 per-bot egress partitioning — hermetic proof against the REAL proxy.
#
# Proves, end-to-end against the compiled binary + real claw-vet:
#   [1] the shared BASE host is reachable by a mapped client
#   [2] a bot reaches its OWN static seed host
#   [3] a host in neither base nor the bot's seed is DENIED (vettable)
#   [4] claw-vet writes the bot's LEARNED namespace; the proxy hot-reloads it
#       (per-bot store, not the global one) → the host becomes reachable
#   [5] peer-bot ISOLATION (the load-bearing property): a second bot is denied
#       the first bot's seed + learned hosts, and vice-versa. Needs a second
#       loopback source IP (127.0.0.2 — native on Linux); SKIPPED where it is
#       unavailable (macOS default), since the go unit test
#       TestHostAllowedFor_PerBotIsolation already proves the decision logic.
#
# Hermetic: real binary + *.invalid hosts (RFC 6761 — never resolve) + a temp
# store. claw-vet --dry-run skips the gateway. Source IP is the identity, so a
# single client is enough for [1]-[4]; [5] adds a second source IP when it can.
#
# Exit code = number of failed assertions (0 = all pass).
set -u
cd "$(dirname "$0")/../.."   # repo root

PORT=31292
PROXY="http://127.0.0.1:${PORT}"
WORK="$(mktemp -d)"
STATIC="${WORK}/base.txt"
SEEDS="${WORK}/seeds"
LEARNED="${WORK}/learned"
BIN="${WORK}/egress-proxy"
LOG="${WORK}/proxy.log"

pass=0 fail=0
ok()  { echo "  ✅ PASS: $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ FAIL: $1"; fail=$((fail + 1)); }
cleanup() { [ -n "${PROXY_PID:-}" ] && kill "${PROXY_PID}" 2>/dev/null; rm -rf "${WORK}"; }
trap cleanup EXIT

mkdir -p "${SEEDS}/vanhelsing" "${SEEDS}/house" "${LEARNED}"
printf 'base.invalid\n'       > "${STATIC}"
printf 'vh-seed.invalid\n'    > "${SEEDS}/vanhelsing/allowlist.txt"
printf 'house-seed.invalid\n' > "${SEEDS}/house/allowlist.txt"

echo "== build proxy =="
( cd sandbox/egress-proxy && CGO_ENABLED=0 go build -o "${BIN}" . ) || { echo "build failed"; exit 99; }

echo "== start proxy (CLIENT_MAP: .1=vanhelsing .2=house, reload 1s) =="
LISTEN="127.0.0.1:${PORT}" ALLOWLIST_FILE="${STATIC}" \
  CLIENT_MAP="127.0.0.1=vanhelsing,127.0.0.2=house" \
  SEED_DIR="${SEEDS}" LEARNED_DIR="${LEARNED}" \
  LEARNED_ALLOWLIST_FILE="${LEARNED}/allowlist.txt" \
  LEARNED_RELOAD_SECONDS=1 SNI_ENFORCE=off \
  "${BIN}" > "${LOG}" 2>&1 &
PROXY_PID=$!
sleep 1

# req <host> [source-ip] → HTTP status code via the proxy (502 = past the gate,
# dial fails for .invalid; 403 = denied at the gate).
req() {
  local iface=""
  [ -n "${2:-}" ] && iface="--interface $2"
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${iface} -x "${PROXY}" "http://$1/" 2>/dev/null
}

echo
echo "== [1] shared base reachable (client vanhelsing @127.0.0.1) =="
c=$(req base.invalid); [ "${c}" = "502" ] && ok "base.invalid past gate (${c})" || bad "base expected 502, got ${c}"

echo
echo "== [2] vanhelsing reaches its OWN seed =="
c=$(req vh-seed.invalid); [ "${c}" = "502" ] && ok "vh-seed.invalid past gate (${c})" || bad "vh-seed expected 502, got ${c}"

echo
echo "== [3] host in neither base nor seed is DENIED =="
c=$(req nope.invalid); [ "${c}" = "403" ] && ok "nope.invalid denied (${c})" || bad "expected 403, got ${c}"

echo
echo "== [4] claw-vet writes vanhelsing LEARNED ns → proxy hot-reloads =="
out=$(OASIS_EGRESS_LEARNED_DIR="${LEARNED}" OASIS_EGRESS_PROXY="hermetic-none" \
      python3 scripts/claw-vet run vh-learn.invalid --bot vanhelsing --dry-run --json 2>&1)
echo "    ${out}"
grep -qx "vh-learn.invalid" "${LEARNED}/vanhelsing/allowlist.txt" 2>/dev/null \
  && ok "written to vanhelsing namespace" || bad "not written to vanhelsing namespace"
[ ! -s "${LEARNED}/allowlist.txt" ] && ok "global store untouched (per-bot only)" || bad "leaked into global store"
sleep 2
c=$(req vh-learn.invalid); [ "${c}" = "502" ] && ok "vh-learn.invalid now reachable for vanhelsing (${c})" || bad "expected 502 after reload, got ${c}"

echo
echo "== [5] peer-bot ISOLATION (second source IP 127.0.0.2) =="
if req base.invalid 127.0.0.2 >/dev/null 2>&1 && [ "$(req base.invalid 127.0.0.2)" = "502" ]; then
  c=$(req house-seed.invalid 127.0.0.2); [ "${c}" = "502" ] && ok "house reaches its own seed (${c})" || bad "house-seed expected 502, got ${c}"
  c=$(req vh-seed.invalid 127.0.0.2);    [ "${c}" = "403" ] && ok "house DENIED vanhelsing's seed (${c}) — ISOLATION" || bad "house should be denied vh-seed, got ${c}"
  c=$(req vh-learn.invalid 127.0.0.2);   [ "${c}" = "403" ] && ok "house DENIED vanhelsing's learned host (${c}) — ISOLATION" || bad "house should be denied vh-learn, got ${c}"
  c=$(req house-seed.invalid);           [ "${c}" = "403" ] && ok "vanhelsing DENIED house's seed (${c}) — ISOLATION" || bad "vanhelsing should be denied house-seed, got ${c}"
else
  echo "  ⏭  SKIP: 127.0.0.2 loopback unavailable (macOS default) — two-bot"
  echo "         isolation is covered by go unit test TestHostAllowedFor_PerBotIsolation."
fi

echo
echo "== [6] audit carries per-bot attribution =="
grep -q '"bot":"vanhelsing"' "${LOG}" && ok "decision audit tags bot=vanhelsing" || bad "no per-bot attribution in audit"

echo
echo "== summary: ${pass} passed, ${fail} failed =="
exit "${fail}"
