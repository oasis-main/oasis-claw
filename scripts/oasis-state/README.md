# oasis-state

Snapshot/restore Nimbus's portable state across "homes" via git + an
S3-compatible object store. Designed for the eventual Linux-MacBook
migration — same tool runs on any host that has Docker, rclone config,
and the age private key.

## Buckets

| Bucket  | Where it goes                                       | Why                                              |
| ------- | --------------------------------------------------- | ------------------------------------------------ |
| text    | `<state-repo>/text/`                                | Plaintext, mergeable, diffable                   |
| secrets | `<state-repo>/secrets.tar.age`                      | age-encrypted; commit ciphertext only            |
| blob    | `<backend>:nimbus-state/blob/<TS>.tar.age`          | Too large for git; pushed to rclone remote(s)    |
| skip    | nowhere                                             | Regenerable on next boot                         |

See [text.list](text.list), [secrets.list](secrets.list),
[blob.list](blob.list), [skip.list](skip.list) for the exact per-bucket
allowlists.

## One-time setup per host

```sh
# 1. Install rclone + age on the host (Linux: apk/apt/pacman; Mac: brew).
brew install rclone age   # or apt install rclone age

# 2. Generate an age keypair (FIRST HOST ONLY — copy the key to other hosts).
mkdir -p ~/.config/oasis-state
age-keygen -o ~/.config/oasis-state/age.key
chmod 600 ~/.config/oasis-state/age.key
# extract the public key for the recipients file:
grep '^# public key:' ~/.config/oasis-state/age.key \
  | sed 's/^# public key: //' > ~/.config/oasis-state/recipients

# 3. Configure an rclone remote. Default name is `r2` (Cloudflare R2).
#    `rclone config` walks you through; pick "Amazon S3" → "Cloudflare R2"
#    or "s3 compat". Use the bucket `nimbus-state`. Test:
rclone lsd r2:nimbus-state

# 4. Clone (or init) the state repo. Default path:
mkdir -p ~/.local/share/oasis-state
git clone git@github.com:<you>/nimbus-state.git ~/.local/share/oasis-state/repo
# or, first time only:
git init --initial-branch=main ~/.local/share/oasis-state/repo
```

## Migrating an additional host (e.g. Mac → Linux MacBook)

```sh
# On the Mac (donor):
~/Documents/Runes/oasis-x/oasis-claw/scripts/oasis-state/snapshot.sh

# Copy the age PRIVATE key out-of-band — scp, USB drive, etc.
scp ~/.config/oasis-state/age.key linux-mbp:~/.config/oasis-state/age.key

# On the Linux MacBook (new host) — assumes oasis-claw checked out:
# - install rclone + age
# - copy rclone.conf (same bucket creds)
# - clone the state repo
cd ~/Documents/Runes/oasis-x/oasis-claw
docker compose -f docker-compose.runtime.yml up --no-start openclaw
docker compose -f docker-compose.runtime.yml stop openclaw
scripts/oasis-state/restore.sh
docker compose -f docker-compose.runtime.yml up -d
```

Nimbus boots on Linux with the same identity, memory, cron schedule, and
conversation history.

## Day-to-day

- `snapshot.sh` — bundle + commit + push. Idempotent.
- `snapshot.sh --dry-run` — preview what would be done.
- `snapshot.sh --no-git-push` — bundle and push blob, skip git commit/push
  (useful for offline testing).
- `restore.sh` — pull latest snapshot from rclone + state repo, restore to
  the volume. Refuses to run if oasis-claw-runtime is up.
- `restore.sh --ts 20260622T180000Z` — restore a specific snapshot.

## Retention

Default: keep last 30 daily snapshots, plus first-of-month for 12 months.
Configurable via `OASIS_STATE_RETAIN_DAILY` / `OASIS_STATE_RETAIN_MONTHLY`.
Applied to both the rclone backend (per-snapshot `.tar.age`) and the
in-repo `snapshots/<ts>/blob.manifest.json` directory tree.

## Daily automation (Mac)

```sh
# Drop a launchd plist analogous to com.oasis-x.nimbus-watchdog,
# but with StartCalendarInterval = 04:00 local and the snapshot.sh path.
# Skipping until you've confirmed manual snapshots work.
```

## Multi-backend mirrors

```sh
# Push the same encrypted blob to multiple backends:
export OASIS_STATE_BACKENDS=r2,b2,storj
scripts/oasis-state/snapshot.sh
```

Each remote must exist in `rclone.conf` under its exact name. Restore
walks backends in the same order and uses the first that responds.

## What's NOT synced

See [skip.list](skip.list) for the full list. Briefly: plugin-runtime-deps
(830 MB of regenerable npm), logs, canvas artifacts, the per-host
`exec-approvals.json` (do NOT carry over — it's host-specific trust
state), and `.gateway-token` (re-minted on first boot).

## Open follow-ups

- **launchd plist** for daily automated snapshots — write once we've
  validated manual snapshots round-trip cleanly.
- **`extensions/oasis-state/` openclaw plugin** for a `/snapshot` slash
  command + status line — convenience layer, not load-bearing.
- **IPFS archive command** — quarterly snapshot pinned to web3.storage
  for public verifiability. Separate command, not part of the daily flow.
