#!/usr/bin/env bash
# oasis-claw git credential helper — emits the per-bot fine-grained PAT for
# github.com over HTTPS, reading it from the GH_TOKEN env var (no network,
# no stored file, nothing written to the volume). Configured in the entrypoint
# as:  git config --global credential.https://github.com.helper oasis-gh
# (git invokes this as `git-credential-oasis-gh get`).
#
# Emitting nothing when GH_TOKEN is unset lets git fall through to anonymous
# access — correct for public reads on a bot that has no token.

case "${1:-}" in
  get)
    [ -n "${GH_TOKEN:-}" ] || exit 0
    printf 'protocol=https\n'
    printf 'host=github.com\n'
    printf 'username=x-access-token\n'
    printf 'password=%s\n' "$GH_TOKEN"
    ;;
  store|erase)
    : ;;   # token is env-sourced; nothing to persist or wipe
esac
exit 0
