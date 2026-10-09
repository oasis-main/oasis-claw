#!/bin/sh
# Start the sandbox sidecar's sshd (inetd mode under socat, no TCP port).
#
# sshd gives each session a clean environment, so the container's env (the
# egress proxy, locale) would not reach exec. This writes an sshd config with
# SetEnv for a fixed list of non-secret names, plus any names in
# OASIS_SBX_ENV_PASS (comma-separated). A name that looks like a credential is
# refused, so a compose typo cannot put a secret into every exec env.
set -eu
CONF=/tmp/sshd_config
# The fleet sets only upper-case proxy names; curl ignores HTTP_PROXY for
# http:// URLs (httpoxy rule) and reads http_proxy. Mirror each one.
for n in HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY; do
  l=$(printf '%s' "$n" | tr 'A-Z' 'a-z')
  v=$(printenv "$n" 2>/dev/null) || continue
  printenv "$l" >/dev/null 2>&1 || export "$l=$v"
done
cp /etc/ssh/sshd_config.sbx "$CONF"
names="HTTPS_PROXY HTTP_PROXY NO_PROXY ALL_PROXY https_proxy http_proxy no_proxy all_proxy LANG LC_ALL TZ PLAYWRIGHT_BROWSERS_PATH XDG_CACHE_HOME npm_config_cache PIP_CACHE_DIR"
names="$names $(printf '%s' "${OASIS_SBX_ENV_PASS:-}" | tr ',' ' ')"
setenv=""
for n in $names; do
  case "$n" in
    *TOKEN*|*KEY*|*SECRET*|*PASSWORD*|*PASSWD*|*CREDENTIAL*|*AUTH*)
      echo "[sbx-start] refusing to pass $n into exec" >&2; continue ;;
  esac
  v=$(printenv "$n" 2>/dev/null) || continue
  case "$v" in *'"'*|*'
'*) echo "[sbx-start] skipping $n (quote or newline in value)" >&2; continue ;; esac
  setenv="$setenv \"$n=$v\""
done
[ -n "$setenv" ] && echo "SetEnv$setenv" >> "$CONF"
exec socat UNIX-LISTEN:/run/sbx/ssh.sock,fork,unlink-early,mode=600 \
  "EXEC:/usr/sbin/sshd -i -e -f $CONF"
