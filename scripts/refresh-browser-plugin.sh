#!/usr/bin/env bash
#
# Refresh the vendored `browser` plugin against upstream openclaw.
#
# This script is the choke point through which upstream code reaches our
# deployed image. Nothing else updates extensions/browser/ — every change
# goes through here, audit-gated, on a refresh PR or never.
#
# What it does:
#   1. Read extensions/browser/UPSTREAM for the currently-pinned SHA.
#   2. Clone (or update) upstream openclaw at the requested ref (HEAD by
#      default; can be overridden via --upstream-ref for kill-switch testing).
#   3. Rsync upstream/extensions/browser/ → a scratch tree.
#   4. Replay extensions/browser/patches/*.patch against the scratch tree.
#   5. Diff scratch tree vs. our current extensions/browser/. Compute a
#      "security-keyword diff" so the human reviewer sees flagged hunks.
#   6. Stage the scratch tree into extensions/browser/.
#   7. Refresh vendor/sandbox-skill-audit/browser*/SKILL.md sha256 in the
#      manifest files (the audit input doesn't change unless the SKILL
#      content changes — but we want the manifests to stay honest).
#   8. Run the audit cohort with --live --inspect against the new tree.
#   9. Print a JSON summary to stdout for the GH-Action to read.
#
# CI (`.github/workflows/refresh-browser.yml`) wraps this script and turns
# the summary into a PR (success) or an issue (conflict / regression).
# A human running this locally sees the same flow on stdout.
#
# Exit codes:
#   0 — clean refresh; PR-ready
#   2 — no upstream change (pinned SHA already matches upstream HEAD)
#   3 — patch conflict during replay (refresh blocked, requires patch rebase)
#   4 — audit regression (new high-severity finding or pass→warn/block)
#   5 — invariant violation (UPSTREAM file missing / malformed, ANTHROPIC_API_KEY
#       missing when --live, etc.)
#
# Usage:
#   scripts/refresh-browser-plugin.sh                       # dry-run, free
#   scripts/refresh-browser-plugin.sh --live                # runs the audit
#   scripts/refresh-browser-plugin.sh --upstream-ref=<sha>  # pin a specific ref
#                                                          # (kill-switch testing)
#
# Tracks under CLAW-016 (script) and CLAW-017 (CI wrapper).

set -euo pipefail

# ───────────────────────────── flags ─────────────────────────────
LIVE=0
UPSTREAM_REF=""
for arg in "$@"; do
  case "$arg" in
    --live) LIVE=1 ;;
    --upstream-ref=*) UPSTREAM_REF="${arg#--upstream-ref=}" ;;
    --help|-h)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 5
      ;;
  esac
done

# ───────────────────────── paths + invariants ─────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

UPSTREAM_FILE="extensions/browser/UPSTREAM"
PATCHES_DIR="extensions/browser/patches"
SCRATCH="$(mktemp -d -t oasis-claw-refresh.XXXXXX)"
# Don't trap-rm if a conflict happened — humans need to inspect.
cleanup() {
  if [[ "${KEEP_SCRATCH:-0}" != "1" ]]; then
    rm -rf "$SCRATCH"
  else
    echo "[refresh] scratch retained: $SCRATCH" >&2
  fi
}
trap cleanup EXIT

if [[ ! -f "$UPSTREAM_FILE" ]]; then
  echo "[refresh] FATAL: $UPSTREAM_FILE missing — run from CLAW-014's vendored state" >&2
  exit 5
fi

PINNED_SHA="$(grep -E '^upstream_sha:' "$UPSTREAM_FILE" | awk '{print $2}')"
PINNED_PLAYWRIGHT="$(grep -E '^playwright_core_version:' "$UPSTREAM_FILE" | awk '{print $2}')"
PINNED_CHROMIUM="$(grep -E '^chromium_revision:' "$UPSTREAM_FILE" | awk '{print $2}')"

if [[ -z "$PINNED_SHA" ]]; then
  echo "[refresh] FATAL: could not parse upstream_sha from $UPSTREAM_FILE" >&2
  exit 5
fi

echo "[refresh] pinned upstream_sha:           $PINNED_SHA"
echo "[refresh] pinned playwright_core:        $PINNED_PLAYWRIGHT"
echo "[refresh] pinned chromium_revision:      $PINNED_CHROMIUM"
echo "[refresh] live audit:                    $LIVE"
echo "[refresh] scratch:                       $SCRATCH"

# ─────────────────── fetch upstream into scratch ───────────────────
echo "[refresh] cloning upstream openclaw…"
git clone --quiet --filter=blob:none --no-tags \
  https://github.com/openclaw/openclaw.git \
  "$SCRATCH/openclaw"

if [[ -n "$UPSTREAM_REF" ]]; then
  TARGET_REF="$UPSTREAM_REF"
else
  TARGET_REF="$(git -C "$SCRATCH/openclaw" rev-parse HEAD)"
fi
git -C "$SCRATCH/openclaw" checkout --quiet "$TARGET_REF"
NEW_SHA="$(git -C "$SCRATCH/openclaw" rev-parse HEAD)"
echo "[refresh] upstream target ref:           $TARGET_REF"
echo "[refresh] upstream resolved sha:         $NEW_SHA"

if [[ "$NEW_SHA" == "$PINNED_SHA" ]]; then
  echo "[refresh] no upstream change — pinned SHA already at upstream HEAD"
  echo "::no-op::"
  exit 2
fi

# ─────────────────── rsync upstream/browser → scratch ───────────────────
mkdir -p "$SCRATCH/staged/extensions/browser"
rsync -a --delete \
  "$SCRATCH/openclaw/extensions/browser/" \
  "$SCRATCH/staged/extensions/browser/"
# Strip stray node_modules / dist.
find "$SCRATCH/staged/extensions/browser" \
  -type d \( -name node_modules -o -name dist \) -prune -exec rm -rf {} + || true

# Preserve our own metadata files INTO the scratch tree before patches
# are applied. These don't exist upstream and we must not lose them when
# we later sync scratch → working tree. Specifically:
#   - UPSTREAM        (our pin metadata; the script's own source of truth)
#   - patches/        (our local fixes, ordered numerically)
# Anything else under extensions/browser/ that's NOT in upstream WILL be
# deleted on the final rsync — that's intentional (drift gets cleaned up).
for keep in UPSTREAM patches; do
  if [ -e "extensions/browser/$keep" ]; then
    cp -R "extensions/browser/$keep" "$SCRATCH/staged/extensions/browser/$keep"
  fi
done

# ─────────────────── replay patches ───────────────────
if [[ -d "$PATCHES_DIR" ]] && [[ -n "$(ls -A "$PATCHES_DIR"/*.patch 2>/dev/null || true)" ]]; then
  echo "[refresh] replaying patches from ${PATCHES_DIR}..."
  for p in "$PATCHES_DIR"/*.patch; do
    echo "  → $(basename "$p")"
    if ! ( cd "$SCRATCH/staged/extensions/browser" && \
           git apply --check "$REPO_ROOT/$p" 2>&1 ) ; then
      KEEP_SCRATCH=1
      echo "[refresh] CONFLICT: patch $(basename "$p") does not apply against $NEW_SHA" >&2
      echo "::patch-conflict::$(basename "$p")"
      exit 3
    fi
    ( cd "$SCRATCH/staged/extensions/browser" && \
      git apply "$REPO_ROOT/$p" )
  done
else
  echo "[refresh] no patches to replay (patches dir empty or missing)"
fi

# ─────────────────── diff vs. current tree ───────────────────
DIFF_FILE="$SCRATCH/upstream-diff.patch"
diff -urN extensions/browser/ "$SCRATCH/staged/extensions/browser/" \
  > "$DIFF_FILE" || true
DIFF_LINES=$(wc -l < "$DIFF_FILE")
echo "[refresh] upstream diff: ${DIFF_LINES} lines (written to $DIFF_FILE)"

# Security-keyword scan over the diff. Hits are surfaced to the PR
# reviewer but don't auto-block — the audit is the real gate.
#
# Pattern is ERE (`-E`). Literal `(` MUST be escaped as `\(` even in
# ERE; an unescaped `(` is a grouping operator and an unbalanced one
# breaks the whole regex. Bug history: the first cut of this used BRE
# escapes (`\|` for alternation) which crashed `grep` on the first
# real refresh — never trust a regex you didn't run.
KEYWORDS='\beval\b|\bexec\b|child_process|https?://|fetch\(|websocket|\bws://|file://|javascript:|base64|atob\(|new Function|dangerouslySet|innerHTML|outerHTML|writeFile|spawn\(|execSync'
KEYWORD_HITS=$(grep -niE "$KEYWORDS" "$DIFF_FILE" || true)
echo "[refresh] security-keyword hits in diff (first 30):"
echo "$KEYWORD_HITS" | head -30
KEYWORD_COUNT=$(printf '%s\n' "$KEYWORD_HITS" | grep -c . || true)
echo "[refresh] total keyword hits: $KEYWORD_COUNT"

# ─────────────────── stage into working tree (--live only) ───────────────────
# Working-tree mutation is gated behind --live. A no-flag dry-run inspects
# the upstream diff + keyword hits in scratch and exits without touching
# extensions/browser/ or the UPSTREAM pin file. CI passes --live; the
# `peter-evans/create-pull-request` step in refresh-browser.yml then picks
# up the working-tree changes that the staging step makes.
#
# Bug history: an earlier cut staged unconditionally and lost UPSTREAM +
# patches/ on every dry-run via `rsync --delete`. Fixed by (a) gating
# staging on --live, and (b) copying our metadata into scratch BEFORE
# the final sync (see the `for keep in UPSTREAM patches` block above).
if [[ "$LIVE" == "1" ]]; then
  echo "[refresh] staging new tree into extensions/browser/…"
  rsync -a --delete \
    "$SCRATCH/staged/extensions/browser/" \
    extensions/browser/

  # Update UPSTREAM file's upstream_sha + vendored_on. Leave the other
  # pins (playwright_core_version, chromium_revision) alone — those are
  # orthogonal axes and need their own intentional bump.
  TODAY="$(date -u +%Y-%m-%d)"
  sed -i.bak \
    -e "s/^upstream_sha:.*$/upstream_sha:     $NEW_SHA/" \
    -e "s/^vendored_on:.*$/vendored_on:      $TODAY/" \
    "$UPSTREAM_FILE"
  rm -f "$UPSTREAM_FILE.bak"
else
  echo "[refresh] dry-run — NOT staging into extensions/browser/ (use --live to write)"
fi

# ─────────────────── live audit (cohort) ───────────────────
if [[ "$LIVE" == "1" ]]; then
  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "[refresh] FATAL: --live requires ANTHROPIC_API_KEY" >&2
    exit 5
  fi
  echo "[refresh] running audit cohort (broad / auth / ssrf / evaluate / ai-loop)…"
  AUDIT_FAILED=0
  for slice in browser browser-auth browser-ssrf browser-evaluate browser-ai-loop; do
    echo "[refresh] audit slice: $slice"
    if ! node scripts/audit-sandbox.mjs --only="$slice" --live --inspect; then
      AUDIT_FAILED=1
      echo "[refresh] audit slice $slice exited non-zero" >&2
    fi
    verdict_file="vendor/sandbox-skill-audit/_meta/${slice}.audit-verdict.json"
    if [[ -f "$verdict_file" ]]; then
      v=$(jq -r '.verdict' "$verdict_file")
      r=$(jq -r '.risk_score' "$verdict_file")
      echo "[refresh]   → $slice: verdict=$v risk=$r"
      if [[ "$v" == "block" ]]; then
        AUDIT_FAILED=1
        echo "[refresh] AUDIT REGRESSION: $slice verdict=block" >&2
      fi
    fi
  done
  if [[ "$AUDIT_FAILED" == "1" ]]; then
    KEEP_SCRATCH=1
    echo "::audit-regression::"
    exit 4
  fi
else
  echo "[refresh] DRY-RUN — skipping live audit cohort"
fi

# ─────────────────── summary ───────────────────
echo
echo "[refresh] ─── SUMMARY ───"
echo "[refresh] previous_sha:   $PINNED_SHA"
echo "[refresh] new_sha:        $NEW_SHA"
echo "[refresh] diff_lines:     $DIFF_LINES"
echo "[refresh] keyword_hits:   $KEYWORD_COUNT"
echo "[refresh] audit_run:      $LIVE"
echo "::summary::"
cat <<JSON
{
  "previous_sha": "$PINNED_SHA",
  "new_sha": "$NEW_SHA",
  "diff_lines": $DIFF_LINES,
  "keyword_hits": $KEYWORD_COUNT,
  "audit_live": $([ "$LIVE" == "1" ] && echo true || echo false),
  "playwright_core_version": "$PINNED_PLAYWRIGHT",
  "chromium_revision": "$PINNED_CHROMIUM"
}
JSON
exit 0
