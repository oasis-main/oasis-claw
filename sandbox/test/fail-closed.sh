#!/usr/bin/env bash
# Fail-closed proof for the operating-system-sandbox egress proxy (CLAW-033).
#
# Proves three properties of the egress boundary, from a client that lives on
# an `internal: true` network (no direct route to the internet):
#   [1] an ALLOWLISTED host is reachable THROUGH the proxy;
#   [2] a NON-allowlisted host is BLOCKED by the proxy (fail-closed, HTTP 403);
#   [3] DIRECT egress bypassing the proxy has NO route out at all
#       (the proxy is the only exit — injection cannot side-step it).
#
# Exit code = number of failed assertions (0 = all pass).
set -u
cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f docker-compose.sandbox.yml)
PROXY="http://egress-proxy:3128"

pass=0 fail=0
run_client() { "${COMPOSE[@]}" run --rm --entrypoint curl sandbox-client "$@"; }
expect_zero() {
  if [ "$1" -eq 0 ]; then echo "  ✅ PASS: $2"; pass=$((pass + 1))
  else echo "  ❌ FAIL: $2 (rc=$1)"; fail=$((fail + 1)); fi
}
expect_nonzero() {
  if [ "$1" -ne 0 ]; then echo "  ✅ PASS: $2 (blocked, rc=$1)"; pass=$((pass + 1))
  else echo "  ❌ FAIL: $2 (rc=0 — NOT blocked!)"; fail=$((fail + 1)); fi
}

echo "== build + start egress proxy =="
"${COMPOSE[@]}" up -d --build egress-proxy || { echo "compose up failed"; exit 99; }
sleep 2

echo
echo "== [1] allowlisted host THROUGH proxy (expect reachable) =="
out=$(run_client -sS -o /dev/null -w 'http_status=%{http_code}' --max-time 30 -x "$PROXY" https://api.anthropic.com/ 2>&1); rc=$?
echo "    ${out} (curl rc=${rc})"
expect_zero "$rc" "allowlisted api.anthropic.com reachable via proxy (TLS tunnel established end-to-end)"

echo
echo "== [2] non-allowlisted host THROUGH proxy (expect fail-closed) =="
out=$(run_client -sS -o /dev/null --max-time 20 -x "$PROXY" https://example.com/ 2>&1); rc=$?
echo "    ${out} (curl rc=${rc})"
expect_nonzero "$rc" "non-allowlisted example.com blocked by proxy"
echo "${out}" | grep -q "403" && echo "    ↳ proxy returned HTTP 403 (explicit deny)"

echo
echo "== [3] direct egress (bypass proxy) from internal net (expect no route) =="
out=$(run_client -sS -o /dev/null --max-time 15 --noproxy '*' https://api.anthropic.com/ 2>&1); rc=$?
echo "    ${out} (curl rc=${rc})"
expect_nonzero "$rc" "direct egress from internal net has no route (proxy is the sole exit)"

echo
echo "== egress-proxy decision log (JSONL audit) =="
"${COMPOSE[@]}" logs egress-proxy 2>/dev/null | tail -20

echo
echo "== summary: ${pass} passed, ${fail} failed =="
"${COMPOSE[@]}" down -v >/dev/null 2>&1
exit "$fail"
