#!/usr/bin/env bash
# oasis-claw git guardrail — shadows /usr/bin/git at /usr/local/bin/git.
#
# PURPOSE: hard-refuse git operations that DESTROY history / prevent rollback,
# and enforce the per-bot push allowlist. This is a FAIL-OPEN, agent-facing
# early-warning layer for the bot's own `git` calls — it is NOT the security
# boundary. The real guarantees are server-side: GitHub branch protection +
# the bot's fine-grained PAT scope. Anything this wrapper is unsure about it
# ALLOWS (so a parser edge case can never brick the fleet's git); it blocks
# only the clearly-dangerous, explicitly-enumerated cases.
#
# BLOCKED (on `git push`):
#   --force / -f / --force-with-lease[=…] / --force-if-includes   (rewrites remote history)
#   --delete / -d                                                 (deletes a remote ref)
#   --mirror                                                      (can delete refs)
#   a refspec beginning ':'  (e.g. :main)                         (colon-refspec delete)
#   a refspec beginning '+'  (e.g. +main:main)                    (leading-plus force)
#   a push whose target github repo is not in OASIS_GIT_REPOS     (out-of-scope write)
# STRIPPED (so the pre-push backstop always runs):
#   --no-verify / -n
#
# Everything else — clone, fetch, pull, add, commit, push (fast-forward),
# branch, checkout, switch, restore, reset, rebase, stash, LOCAL tag/branch
# deletes, etc. — is exec'd straight through to /usr/bin/git unchanged.
#
# OASIS_GIT_REPOS: space/comma-separated owner/repo allowlist for pushes.
#   unset / empty  -> allowlist NOT enforced (push scope governed by PAT only)
#   contains '*'   -> all repos allowed (e.g. Yes Man)
#   else           -> push target must match one entry (case-insensitive)

set -u
REAL_GIT="${OASIS_REAL_GIT:-/usr/bin/git}"
LOG="${OASIS_GIT_POLICY_LOG:-$HOME/.openclaw/logs/git-policy.log}"

_log() {
  { printf '%s %s :: ' "$(date -u +%FT%TZ 2>/dev/null || echo '?')" "$1"
    shift; printf '%q ' "$@"; printf '\n'; } >>"$LOG" 2>/dev/null || true
}

deny() {
  local why="$1"
  printf '\n✋ oasis-git-policy: BLOCKED — %s\n' "$why" >&2
  printf '   This would destroy history / prevent rollback, or is outside this bot'\''s repo scope.\n' >&2
  printf '   Rollback-safe by policy. If you truly need it, ask Mike — GitHub branch\n' >&2
  printf '   protection + this token'\''s scope would reject it server-side anyway.\n\n' >&2
  _log "BLOCKED($why)" "$@"
  exit 13
}

# Nothing to guard on a bare `git`.
[ "$#" -eq 0 ] && exec "$REAL_GIT"

# ── locate the subcommand, skipping the common global options ──────────────
# Fail-open: if we can't confidently find it, just pass through.
argv=("$@")
n=${#argv[@]}
i=0
subcmd=""
sub_idx=-1
while [ "$i" -lt "$n" ]; do
  a="${argv[$i]}"
  case "$a" in
    -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env)
      i=$((i + 2)); continue ;;                      # global option that takes a value
    -c=*|--git-dir=*|--work-tree=*|--namespace=*|--exec-path=*|--super-prefix=*|--config-env=*)
      i=$((i + 1)); continue ;;                      # value glued with '='
    -p|--paginate|-P|--no-pager|--bare|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks)
      i=$((i + 1)); continue ;;                      # global flags, no value
    -*)
      i=$((i + 1)); continue ;;                      # unknown global flag — skip, stay fail-open
    *)
      subcmd="$a"; sub_idx="$i"; break ;;
  esac
done

# Only `push` is dangerous for rollback; everything else passes through.
if [ "$subcmd" != "push" ]; then
  exec "$REAL_GIT" "$@"
fi

# ── inspect the push arguments (everything after the 'push' token) ─────────
rest=("${argv[@]:$((sub_idx + 1))}")
declare -a forwarded=()
remote_arg=""
declare -a refspecs=()
for tok in "${rest[@]}"; do
  case "$tok" in
    -f|--force|--force-if-includes)
      deny "force-push (rewrites remote history)" "$@" ;;
    --force-with-lease|--force-with-lease=*)
      deny "force-push --force-with-lease (still overwrites remote history)" "$@" ;;
    --mirror)
      deny "push --mirror (can delete remote refs)" "$@" ;;
    -d|--delete)
      deny "push --delete (removes a remote branch/tag)" "$@" ;;
    -n|--no-verify)
      # strip so the pre-push backstop always runs; do not forward
      _log "STRIP(--no-verify)" "$@"; continue ;;
    :*)
      deny "colon-refspec delete ('$tok' removes a remote ref)" "$@" ;;
    +*)
      deny "leading-plus refspec ('$tok' forces / overwrites the remote ref)" "$@" ;;
    -*)
      forwarded+=("$tok") ;;                          # some other push flag — keep
    *)
      # positional: first is the remote, rest are refspecs
      if [ -z "$remote_arg" ]; then remote_arg="$tok"; else refspecs+=("$tok"); fi
      forwarded+=("$tok") ;;
  esac
done

# ── per-bot push allowlist (OASIS_GIT_REPOS) ───────────────────────────────
allow="${OASIS_GIT_REPOS:-}"
allow="${allow//,/ }"
if [ -n "${allow// /}" ] && [[ " $allow " != *" * "* ]]; then
  # Resolve the push target to owner/repo.
  target_url=""
  case "$remote_arg" in
    *://*|*@*:*|*github.com*) target_url="$remote_arg" ;;               # a URL was given directly
    "")                       target_url="$("$REAL_GIT" remote get-url origin 2>/dev/null)" ;;
    *)                        target_url="$("$REAL_GIT" remote get-url "$remote_arg" 2>/dev/null)" ;;
  esac
  # Extract owner/repo from the URL (https or ssh), strip trailing .git.
  slug="$(printf '%s' "$target_url" \
    | sed -E 's#^[a-zA-Z]+://[^/]+/#/#; s#^[^:/]+@[^:/]+:#/#; s#^git@[^:]+:#/#' \
    | sed -E 's#^/+##; s#\.git$##' \
    | awk -F/ 'NF>=2{print $(NF-1)"/"$NF}')"
  if [ -n "$slug" ]; then
    ok=""
    lc_slug="$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]')"
    for entry in $allow; do
      lc_entry="$(printf '%s' "$entry" | tr '[:upper:]' '[:lower:]')"
      # allow "owner/repo" or a bare "owner/*" wildcard
      if [ "$lc_entry" = "$lc_slug" ] || { [ "${lc_entry##*/}" = "*" ] && [ "${lc_entry%%/*}" = "${lc_slug%%/*}" ]; }; then
        ok=1; break
      fi
    done
    [ -z "$ok" ] && deny "push target '$slug' is outside this bot's repo scope (OASIS_GIT_REPOS)" "$@"
  fi
  # If we couldn't resolve a slug, fail open (unknown remote/local push).
fi

_log "ALLOW(push)" "$@"
# Rebuild argv with --no-verify stripped: keep global opts + 'push' + forwarded.
exec "$REAL_GIT" "${argv[@]:0:$((sub_idx + 1))}" "${forwarded[@]}"
