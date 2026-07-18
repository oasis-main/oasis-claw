#!/usr/bin/env bash
# CLAW-050 two-source-IP isolation — proven in the REAL prod topology (Linux,
# distinct client source IPs) against the compiled proxy.
#
# This is the load-bearing security property of per-bot egress partitioning:
# a bot cannot reach a PEER bot's allowlisted hosts, and identity is the source
# IP (which an unprivileged container cannot spoof). The native per-bot-egress.sh
# proves the wiring cross-platform but must SKIP two-bot isolation on macOS (no
# 127.0.0.2 loopback). This test closes that gap on any host with Docker by
# running the proxy + two curl clients (127.0.0.1, 127.0.0.2 — native loopback
# range on Linux) inside one alpine container.
#
# Hermetic: static cross-compiled binary + *.invalid hosts + a temp store. No
# gateway, no fleet containers touched. Exit code = failed assertions.
set -u
cd "$(dirname "$0")/../.."   # repo root

WORK="$(mktemp -d)"
cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT

mkdir -p "${WORK}/seeds/vanhelsing" "${WORK}/seeds/house" "${WORK}/learned/vanhelsing"
printf 'base.invalid\n'       > "${WORK}/base.txt"
printf 'vh-seed.invalid\n'    > "${WORK}/seeds/vanhelsing/allowlist.txt"
printf 'house-seed.invalid\n' > "${WORK}/seeds/house/allowlist.txt"
printf 'vh-learn.invalid\n'   > "${WORK}/learned/vanhelsing/allowlist.txt"

# Docker Desktop's Linux VM matches the host CPU; build for it. Fall back to
# amd64 if uname is unexpected.
case "$(uname -m)" in
  arm64|aarch64) GOARCH=arm64 ;;
  *)             GOARCH=amd64 ;;
esac
echo "== cross-compile linux/${GOARCH} static binary =="
( cd sandbox/egress-proxy && CGO_ENABLED=0 GOOS=linux GOARCH="${GOARCH}" go build -o "${WORK}/egress-proxy" . ) \
  || { echo "build failed"; exit 99; }

echo "== run proxy + two source-IP clients inside alpine =="
docker run --rm -v "${WORK}:/work:ro" alpine:3.20 sh -c '
  apk add --no-cache curl >/dev/null 2>&1
  cp /work/egress-proxy /tmp/ep && chmod +x /tmp/ep
  LISTEN="127.0.0.1:3128" ALLOWLIST_FILE="/work/base.txt" \
    CLIENT_MAP="127.0.0.1=vanhelsing,127.0.0.2=house" \
    SEED_DIR="/work/seeds" LEARNED_DIR="/work/learned" \
    LEARNED_RELOAD_SECONDS=0 SNI_ENFORCE=off /tmp/ep >/tmp/log 2>&1 &
  sleep 1
  P=http://127.0.0.1:3128
  code(){ curl -s -o /dev/null -w "%{http_code}" --max-time 5 --interface "$2" -x "$P" "http://$1/" 2>/dev/null; }
  fail=0
  chk(){ [ "$2" = "$3" ] && echo "  ✅ $1" || { echo "  ❌ $1 (want $3 got $2)"; fail=$((fail+1)); }; }
  # vanhelsing @127.0.0.1 — own hosts + base allowed; peer host denied
  chk "vh reaches own seed"     "$(code vh-seed.invalid    127.0.0.1)" 502
  chk "vh reaches own learned"  "$(code vh-learn.invalid   127.0.0.1)" 502
  chk "vh reaches shared base"  "$(code base.invalid       127.0.0.1)" 502
  chk "vh DENIED house seed"    "$(code house-seed.invalid 127.0.0.1)" 403
  # house @127.0.0.2 — own host + base allowed; both vh hosts denied (ISOLATION)
  chk "house reaches own seed"  "$(code house-seed.invalid 127.0.0.2)" 502
  chk "house reaches base"      "$(code base.invalid       127.0.0.2)" 502
  chk "house DENIED vh seed"    "$(code vh-seed.invalid    127.0.0.2)" 403
  chk "house DENIED vh learned" "$(code vh-learn.invalid   127.0.0.2)" 403
  grep -q "\"bot\":\"house\"" /tmp/log && echo "  ✅ audit tags bot=house" || { echo "  ❌ no house attribution"; fail=$((fail+1)); }
  echo "== isolation: $fail failed =="
  exit $fail
'
rc=$?
echo "exit=${rc}"
exit "${rc}"
