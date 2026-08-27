#!/usr/bin/env bash
# Static portability lint for this repo's shell scripts.
#
# WHY THIS EXISTS. macOS ships bash 3.2.57 as /bin/bash and nothing newer, and
# a Mac with no Homebrew bash resolves `#!/usr/bin/env bash` to it. Two classes
# of breakage follow, and neither shows up on a developer machine running
# bash 5:
#
#   1. MULTI-BYTE AFTER AN UNBRACED EXPANSION. In a UTF-8 locale, bash 3.2
#      absorbs the first byte of a following multi-byte character into the
#      variable NAME. `"$DIR…"` becomes the name DIR\xE2, which is unset, and
#      `set -u` aborts the script. Measured 2026-08-27: fails under bash 3.2
#      with LANG=en_US.UTF-8, passes under bash 3.2 with LC_ALL=C and under
#      bash 5.2 in either locale. It cost one silent mid-run abort in this repo
#      (scripts/refresh-browser-plugin.sh) and one failed install elsewhere.
#      Fix: brace it — ${DIR} — or use plain ASCII "...".
#
#   2. BASH 4+ ONLY SYNTAX. declare -A, local -n, mapfile, readarray,
#      ${v,,} / ${v^^}, &>> and ;;& do not exist in 3.2.
#
# This lint is STATIC, so it catches both from any platform, including CI on
# Linux. It is not a substitute for running the script on bash 3.2.
#
# EXEMPTING A SCRIPT. A script that only ever runs INSIDE a Linux container
# faces neither problem: the image ships bash 5. Mark it, and both checks are
# skipped for it (it is still parsed):
#
#   # shell-portability: linux-only  -- <why>
#
# Put the reason in. The marker is a claim about WHERE the script runs, and a
# script that later gains a host caller must lose the marker.
#
# Usage:  scripts/lint-shell-portability.sh [file ...]
#         with no arguments it lints every tracked shell file.

set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

files=()
if [ "$#" -gt 0 ]; then
  files=("$@")
else
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    case "$f" in
      */lint-shell-portability.sh) continue ;;   # documents the patterns it bans
      vendor/*|node_modules/*) continue ;;
    esac
    case "$f" in
      *.sh|*.bash|*.mk|Makefile|*/Makefile) files+=("$f") ;;
      *) head -1 "$f" 2>/dev/null | grep -qE '^#!.*(ba)?sh' && files+=("$f") || true ;;
    esac
  done < <(git ls-files)
fi

fail=0
report() { printf '  %s\n' "$*"; fail=1; }

for f in "${files[@]}"; do
  # A container-only script runs on the image's bash 5, so neither check
  # applies. It is still parsed below.
  if grep -q 'shell-portability: linux-only' "$f" 2>/dev/null; then
    linux_only=1
  else
    linux_only=0
  fi

  # 1. unbraced expansion immediately followed by a non-ASCII byte
  hits=""
  [ "$linux_only" = "1" ] || hits="$(perl -ne 'print "$.: $_" if /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/' "$f" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    printf '%s: unbraced expansion followed by a multi-byte character (breaks bash 3.2 + UTF-8)\n' "$f"
    printf '%s\n' "$hits" | sed 's/^/    /'
    report "fix: brace it as \${NAME}, or replace the character with ASCII"
  fi

  # 2. bash 4+ only syntax. Patterns are written so this file's own prose
  #    cannot match them.
  b4=""
  [ "$linux_only" = "1" ] || b4="$(grep -nE 'declare[[:space:]]+-A|local[[:space:]]+-n[[:space:]]|mapfile|readarray|\$\{[A-Za-z_][A-Za-z0-9_]*(,,|\^\^)\}|&>>|;;&' "$f" 2>/dev/null || true)"
  if [ -n "$b4" ]; then
    printf '%s: bash 4+ only syntax (macOS ships bash 3.2)\n' "$f"
    printf '%s\n' "$b4" | sed 's/^/    /'
    report "fix: use a bash 3.2 equivalent"
  fi

  # 3. parses at all
  case "$f" in
    *.mk|Makefile|*/Makefile) ;;
    *) bash -n "$f" 2>/dev/null || { printf '%s: does not parse\n' "$f"; report "fix: bash -n $f"; } ;;
  esac
done

if [ "$fail" -eq 0 ]; then
  printf 'shell portability: %d file(s) clean\n' "${#files[@]}"
else
  printf '\nshell portability: FAILED\n'
fi
exit "$fail"
