#!/usr/bin/env bash
# Sandbox CANARY smoke — CLAW-031 gate before applying the sandbox-runtime
# overlay to Nimbus or Van Helsing.
#
# Boots ONE throwaway openclaw runtime container on the actual sandbox topology
# (`internal:true` network + egress-proxy sole exit) and proves:
#   [A] the runtime reaches healthy state under the overlay (no missing-provider
#       boot fail because HTTPS_PROXY blocks something);
#   [B] a real Anthropic call succeeds THROUGH the proxy (openclaw's Undici
#       env-proxy dispatcher honors HTTPS_PROXY);
#   [C] the egress-proxy audit log shows an ALLOW for api.anthropic.com — the
#       proof-by-log that the call actually rode the sidecar;
#   [D] a DENIED-egress attempt (curl to example.com) inside the runtime is
#       BLOCKED by the sidecar with the runtime seeing HTTP 403.
#
# This is billed — it makes a real (short) provider call. It reuses the main
# runtime .env for ANTHROPIC_API_KEY and blanks every other provider + Telegram
# so it can't clash with the live Nimbus poller or hit an unallowlisted host.
# Volume + containers are deleted at the end.
set -u -o pipefail
cd "$(dirname "$0")"
COMPOSE=(docker compose -f docker-compose.canary.yml -p oasis-canary)

pass=0 fail=0
zero()    { if [ "$1" -eq 0 ]; then echo "  ✅ PASS: $2"; pass=$((pass+1)); else echo "  ❌ FAIL: $2 (rc=$1)"; fail=$((fail+1)); fi; }
nonzero() { if [ "$1" -ne 0 ]; then echo "  ✅ PASS: $2 (blocked)"; pass=$((pass+1)); else echo "  ❌ FAIL: $2 (NOT blocked!)"; fail=$((fail+1)); fi; }
teardown() { "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1; }
trap teardown EXIT

echo "== boot canary openclaw on internal:true + egress-proxy sole-exit =="
"${COMPOSE[@]}" up -d --build 2>&1 | tail -6
echo

echo "== wait for gateway healthz (up to 90s) =="
for i in $(seq 1 30); do
  st=$("${COMPOSE[@]}" ps --format '{{.Health}}' openclaw-canary 2>/dev/null | head -1)
  [ "$st" = "healthy" ] && break
  sleep 3
done
if [ "$st" = "healthy" ]; then echo "  ✅ [A] gateway healthy under HTTPS_PROXY overlay"; pass=$((pass+1))
else echo "  ❌ [A] gateway NOT healthy (last state: '$st'). Recent logs:"; "${COMPOSE[@]}" logs --tail 40 openclaw-canary; fail=$((fail+1))
fi

echo
echo "== [B] provoke a real Anthropic call through the proxy =="
# Two probes: (B1) a low-level curl proves the sidecar carries Anthropic TLS
# CONNECT end-to-end; (B2) an openclaw one-shot proves openclaw's own HTTP
# client honors HTTPS_PROXY. Either passing is decisive for CLAW-031; both
# passing is the strongest signal.

echo
echo "--- [B1] curl api.anthropic.com/v1/models (auth-required — 401 is a valid TLS-tunnel-worked signal) ---"
b1_out=$("${COMPOSE[@]}" exec -T openclaw-canary bash -lc \
      "curl -sS -o /dev/null -w 'http_status=%{http_code}\n' --max-time 20 \
            -H 'x-api-key: probe' -H 'anthropic-version: 2023-06-01' \
            https://api.anthropic.com/v1/models 2>&1" || true)
echo "    ${b1_out}"
# 401/403 = TLS tunnel worked, Anthropic rejected our fake key. 000 = never reached.
if echo "$b1_out" | grep -qE 'http_status=(401|403|200)'; then
  echo "  ✅ [B1] Anthropic TLS tunnel established through sidecar"; pass=$((pass+1))
else
  echo "  ❌ [B1] Anthropic unreachable through sidecar"; fail=$((fail+1))
fi

echo
echo "--- [B2] openclaw agent --local --model anthropic/... (drives openclaw HTTP client) ---"
b2_out=$("${COMPOSE[@]}" exec -T openclaw-canary bash -lc \
      "openclaw agent --local --session-key agent:canary:pingpong --model anthropic/claude-sonnet-4-6 --message 'Reply with exactly the single word PONG.' 2>&1" || true)
echo "$b2_out" | tail -6
if echo "$b2_out" | grep -qi 'pong'; then
  echo "  ✅ [B2] openclaw agent got Anthropic reply through sidecar"; pass=$((pass+1))
else
  echo "  ⚠️  [B2] openclaw agent did NOT reply 'PONG' — inspect output above"; fail=$((fail+1))
fi

echo
echo "== [C] egress-proxy audit shows an ALLOW for api.anthropic.com =="
log=$("${COMPOSE[@]}" logs egress-proxy 2>/dev/null)
if echo "$log" | grep -q '"action":"allow".*"host":"api.anthropic.com"'; then
  echo "  ✅ [C] audit confirms Anthropic egress rode the sidecar"; pass=$((pass+1))
else
  echo "  ❌ [C] no allow-audit for api.anthropic.com — the call did NOT go through the proxy"
  echo "$log" | grep -o '"event":"decision"[^}]*' | head -10; fail=$((fail+1))
fi

echo
echo "== [D] denied-egress: curl example.com from inside the runtime =="
d_out=$("${COMPOSE[@]}" exec -T openclaw-canary bash -lc \
  "curl -sS -o /dev/null -w 'http_status=%{http_code}\n' --max-time 15 https://example.com/ 2>&1; echo rc=\$?" || true)
echo "    ${d_out}"
# Inner curl rc — extract from the echo'd rc=N. A non-zero curl rc + explicit
# "CONNECT tunnel failed, response 403" = fail-closed at the sidecar.
if echo "$d_out" | grep -q 'CONNECT tunnel failed, response 403'; then
  echo "  ✅ [D] example.com blocked at the sidecar (HTTP 403 from proxy)"; pass=$((pass+1))
else
  echo "  ❌ [D] example.com NOT blocked (unexpected)"; fail=$((fail+1))
fi

echo
echo "== summary: ${pass} passed, ${fail} failed =="
exit "$fail"
