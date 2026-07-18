#!/usr/bin/env bash
# Filesystem-reach proof for the operating-system-sandbox (CLAW-033 / launch gate).
#
# The egress tests prove a compromised loop cannot exfiltrate. This proves the
# OTHER half of "reach": when we grant a bot a directory by read-only bind mount,
# a fully-compromised loop inside the container can read exactly that directory
# and NOTHING else — no host secrets, no host writes, no privilege escalation.
#
# It runs the ACTUAL runtime image (oasis-claw-runtime:local) with the exact
# hardening flags from docker-compose.runtime.yml, plus a read-only mount of a
# throwaway fixture dir, and asserts:
#   [1] the granted dir is readable          (reach works);
#   [2] the granted mount is read-only        (can't tamper what it reads);
#   [3] the container rootfs is read-only      (can't persist to the image);
#   [4] $HOME is not writable (no volume here) (no host write surface);
#   [5] a SIBLING secret dir is NOT reachable  (mount is scoped, not the parent);
#   [6] `..` cannot escape the mount to the host sibling (no traversal out);
#   [7] the macOS host FS (/Users, do_key) is absent (no host root mount);
#   [8] the loop runs non-root with an EMPTY capability set;
#   [9] NoNewPrivs=1 (setuid binaries can't escalate);
#  [10] mknod is blocked (CAP_MKNOD dropped — representative privileged op).
#
# Fixtures are fake (dummy notes.txt + fake api_key). No real path is mounted.
# Exit code = number of failed assertions (0 = all pass).
set -u
IMAGE="${IMAGE:-oasis-claw-runtime:local}"

FIX="$(mktemp -d)"
cleanup() { rm -rf "$FIX"; }
trap cleanup EXIT

mkdir -p "$FIX/reach" "$FIX/secret"
echo "granted-directory content the bot is allowed to read" > "$FIX/reach/notes.txt"
echo "SECRET-DO-NOT-LEAK-abc123" > "$FIX/secret/api_key"

cat > "$FIX/assert.sh" <<'ASSERT'
fail=0
zero()    { if [ "$1" -eq 0 ]; then echo "  ✅ PASS: $2"; else echo "  ❌ FAIL: $2 (rc=$1)"; fail=$((fail+1)); fi; }
nonzero() { if [ "$1" -ne 0 ]; then echo "  ✅ PASS: $2 (blocked)"; else echo "  ❌ FAIL: $2 (NOT blocked!)"; fail=$((fail+1)); fi; }

cat /reach/notes.txt >/dev/null 2>&1;            zero    $? "[1] granted /reach readable (reach works)"
touch /reach/evil 2>/dev/null;                   nonzero $? "[2] granted /reach is READ-ONLY"
touch /etc/evil 2>/dev/null;                     nonzero $? "[3] container rootfs read-only (/etc unwritable)"
touch "$HOME/evil" 2>/dev/null;                  nonzero $? "[4] \$HOME unwritable (no volume mounted)"
cat /secret/api_key 2>/dev/null;                 nonzero $? "[5] sibling /secret NOT mounted/reachable"
cat /reach/../secret/api_key 2>/dev/null;        nonzero $? "[6] '..' cannot escape mount to host sibling"
ls /Users/Michaellee 2>/dev/null | grep -q . ;   nonzero $? "[7a] macOS host /Users absent in container"
cat /Users/Michaellee/do_key 2>/dev/null;        nonzero $? "[7b] host do_key not readable"

uid=$(id -u)
if [ "$uid" != "0" ]; then echo "  ✅ PASS: [8a] non-root (uid=$uid)"; else echo "  ❌ FAIL: [8a] running as root"; fail=$((fail+1)); fi
capeff=$(grep CapEff /proc/self/status | tr -d ' \t' | cut -d: -f2)
if [ "$capeff" = "0000000000000000" ]; then echo "  ✅ PASS: [8b] empty capability set (CapEff=$capeff)"; else echo "  ❌ FAIL: [8b] non-empty caps (CapEff=$capeff)"; fail=$((fail+1)); fi
nnp=$(grep NoNewPrivs /proc/self/status | tr -d ' \t' | cut -d: -f2)
if [ "$nnp" = "1" ]; then echo "  ✅ PASS: [9] NoNewPrivs=1 (setuid escalation disabled)"; else echo "  ❌ FAIL: [9] NoNewPrivs=$nnp"; fail=$((fail+1)); fi
if command -v mknod >/dev/null 2>&1; then
  mknod /tmp/dev0 c 1 3 2>/dev/null;             nonzero $? "[10] mknod blocked (CAP_MKNOD dropped)"
else
  echo "  ⚠️  SKIP: [10] mknod not present in image"
fi

echo "FSISO_FAILS=$fail"
exit $fail
ASSERT

echo "== filesystem-reach proof: runtime image + runtime hardening + read-only mount =="
echo "   image=$IMAGE  fixture=$FIX"
echo

docker run --rm \
  --user node \
  --read-only \
  --tmpfs /tmp:size=64m,mode=1777 \
  --tmpfs /home/node/.cache:size=32m,mode=0700 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --network none \
  -v "$FIX/reach:/reach:ro" \
  -v "$FIX/assert.sh:/assert.sh:ro" \
  --entrypoint bash \
  "$IMAGE" /assert.sh
rc=$?

echo
if [ "$rc" -eq 0 ]; then
  echo "== summary: ALL filesystem-reach assertions passed =="
else
  echo "== summary: $rc filesystem-reach assertion(s) FAILED =="
fi
exit "$rc"
