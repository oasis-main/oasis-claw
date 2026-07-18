#!/usr/bin/env bash
# Adversarial egress proof for the operating-system-sandbox proxy (CLAW-037).
#
# fail-closed.sh proves the happy-path boundary (allowlisted through, unknown
# blocked, no direct route). THIS script attacks the boundary the way an injected
# agent loop would, and asserts every bypass fails closed:
#
#   [1] positive control — an allowlisted host is still reachable under strict SNI;
#   [2] domain fronting — CONNECT an allowlisted host, hide a DIFFERENT SNI inside
#       the tunnel → denied by the strictly-subtractive SNI check;
#   [3] DNS rebinding → cloud metadata — an allowlisted NAME that resolves to
#       169.254.169.254 → denied by the special-use-IP guard;
#   [4] SSRF → RFC1918 internal — allowlisted name → 10.0.0.5 → denied;
#   [5] SSRF → host loopback — allowlisted name → 127.0.0.1 → denied;
#   [6] raw-IP CONNECT — CONNECT a non-allowlisted public IP literal → denied;
#   [7] proxy bypass — raw egress from the internal net without the proxy → no route.
#
# [3][4][5] are the important ones: they prove a hostname ON THE ALLOWLIST still
# cannot be used to reach an internal address — the DNS-trust caveat, closed.
#
# Exit code = number of failed assertions (0 = all pass).
set -u
cd "$(dirname "$0")"
COMPOSE=(docker compose -f docker-compose.adversarial.yml)
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

echo "== build + start adversarial egress proxy (SNI_ENFORCE=strict) =="
"${COMPOSE[@]}" up -d --build egress-proxy || { echo "compose up failed"; exit 99; }
sleep 2

echo
echo "== [1] positive control: allowlisted host reachable under strict SNI =="
out=$(run_client -sS -o /dev/null -w 'http_status=%{http_code}' --max-time 30 -x "$PROXY" https://api.telegram.org/ 2>&1); rc=$?
echo "    ${out} (curl rc=${rc})"
expect_zero "$rc" "allowlisted api.telegram.org reachable (strict SNI allows a matching server_name)"

echo
echo "== [2] domain fronting: CONNECT allowlisted host, SNI a different host =="
out=$(run_client -sS -o /dev/null --max-time 25 -x "$PROXY" \
        --connect-to evil.example:443:api.telegram.org:443 https://evil.example/ 2>&1); rc=$?
echo "    ${out} (curl rc=${rc})"
expect_nonzero "$rc" "fronted SNI (evil.example inside a telegram tunnel) denied by SNI check"

echo
echo "== [3] DNS rebinding → cloud metadata (allowlisted NAME → 169.254.169.254) =="
out=$(run_client -sS -o /dev/null --max-time 20 -x "$PROXY" https://metadata.test/ 2>&1); rc=$?
echo "    ${out} (curl rc=${rc})"
expect_nonzero "$rc" "allowlisted metadata.test resolving to link-local metadata IP denied by IP guard"

echo
echo "== [4] SSRF → RFC1918 internal host (allowlisted NAME → 10.0.0.5) =="
out=$(run_client -sS -o /dev/null --max-time 20 -x "$PROXY" https://internal.test/ 2>&1); rc=$?
echo "    ${out} (curl rc=${rc})"
expect_nonzero "$rc" "allowlisted internal.test resolving to RFC1918 IP denied by IP guard"

echo
echo "== [5] SSRF → host loopback (allowlisted NAME → 127.0.0.1) =="
out=$(run_client -sS -o /dev/null --max-time 20 -x "$PROXY" https://loopback.test/ 2>&1); rc=$?
echo "    ${out} (curl rc=${rc})"
expect_nonzero "$rc" "allowlisted loopback.test resolving to loopback denied by IP guard"

echo
echo "== [6] raw-IP CONNECT to a non-allowlisted public IP literal =="
out=$(run_client -sS -o /dev/null --max-time 20 -x "$PROXY" https://1.1.1.1/ 2>&1); rc=$?
echo "    ${out} (curl rc=${rc})"
expect_nonzero "$rc" "CONNECT to raw public IP 1.1.1.1 (not allowlisted) denied by host check"

echo
echo "== [7] proxy bypass: raw egress from internal net, no proxy =="
out=$(run_client -sS -o /dev/null --max-time 12 --noproxy '*' https://1.1.1.1/ 2>&1); rc=$?
echo "    ${out} (curl rc=${rc})"
expect_nonzero "$rc" "direct egress from internal net has no route (proxy is the sole exit)"

echo
echo "== egress-proxy decision log — deny reasons (JSONL audit) =="
log=$("${COMPOSE[@]}" logs egress-proxy 2>/dev/null)
echo "$log" | grep -o '"reason":"[a-z-]*"' | sort | uniq -c
echo "  ↳ expecting: sni-strict-fail (×1), resolved-to-blocked-ip (×3), host-not-allowlisted (×1)"
for reason in sni-strict-fail resolved-to-blocked-ip host-not-allowlisted; do
  if echo "$log" | grep -q "\"reason\":\"${reason}\""; then
    echo "  ✅ audit recorded: ${reason}"; pass=$((pass + 1))
  else
    echo "  ❌ audit MISSING: ${reason}"; fail=$((fail + 1))
  fi
done

echo
echo "== summary: ${pass} passed, ${fail} failed =="
"${COMPOSE[@]}" down -v >/dev/null 2>&1
exit "$fail"
