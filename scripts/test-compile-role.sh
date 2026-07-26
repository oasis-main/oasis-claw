#!/usr/bin/env bash
# CLAW-047 compile-role.py — reach-emitter contract (the security-relevant bits).
#
# Locks the safe-by-construction properties of --emit-reach-compose:
#   [1] host reads default to :ro (a missing/typo'd mode can only be SAFER)
#   [2] `mode: rw` is honored (the trusted-broad bot's opt-in write)
#   [3] the role.yaml mount is ABSOLUTE + :ro (a bare relative source is mis-parsed
#       by compose as a named volume — the bug that bit the first VH recreate)
#   [4] write_volumes render as container-only named volumes (never host binds)
#
# Hermetic: a fixture role.yaml in a temp dir; no docker, no gateway.
# Exit code = failed assertions (0 = all pass).
set -u
cd "$(dirname "$0")/.."   # repo root
COMPILE="scripts/compile-role.py"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

mkdir -p "${WORK}/testbot"
cat > "${WORK}/testbot/role.yaml" <<'YAML'
role: fixture
phase: t
reach:
  read:
    - { host: /Users/x/ro-dir,  at: /reach/ro }
    - { host: /Users/x/rw-dir,  at: /reach/rw, mode: rw }
    - { host: /Users/x/typo,    at: /reach/typo, mode: bogus }
  write_volumes:
    - { name: testbot_work, at: /work }
YAML

out="$(python3 "${COMPILE}" --emit-reach-compose "${WORK}/testbot/role.yaml" 2>&1)"
pass=0 fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; fail=$((fail + 1)); echo "    ---- output ----"; echo "${out}" | sed 's/^/    /'; }

grep -q -- '/Users/x/ro-dir:/reach/ro:ro'   <<<"${out}" && ok "[1] read defaults to :ro"            || bad "[1] read did not default to :ro"
grep -q -- '/Users/x/rw-dir:/reach/rw:rw'   <<<"${out}" && ok "[2] mode: rw honored"                 || bad "[2] mode: rw not honored"
grep -q -- '/Users/x/typo:/reach/typo:ro'   <<<"${out}" && ok "[3] unknown mode forced to :ro"       || bad "[3] unknown mode not forced to :ro"
grep -qE -- '/testbot/role.yaml:/app/role.yaml:ro' <<<"${out}" \
  && grep -q -- "${WORK}/testbot/role.yaml:/app/role.yaml:ro" <<<"${out}" \
  && ok "[4] role.yaml mount is absolute + :ro" || bad "[4] role.yaml mount not absolute+:ro"
grep -q -- 'testbot_work:/work'             <<<"${out}" && ok "[5] write_volume renders as named volume" || bad "[5] write_volume missing"
grep -q -- '/Users/x/typo' <<<"${out}" && ! grep -q -- '/reach/typo:bogus' <<<"${out}" && ok "[6] no unsanitized mode leaks through" || bad "[6] raw mode leaked"

echo
echo "== compile-role reach contract: ${pass} passed, ${fail} failed =="
exit "${fail}"
