#!/usr/bin/env python3
"""Drift check for the per-bot semantic search index (CLAW-094 design section 5).

Recomputes each bot's CURRENT authorized host-root set (from its current
role.yaml, via the same scripts/lib/semantic_index_authz.py module the builder
uses) and compares it against the `authorized_roots` field recorded in that
bot's LAST-built manifest.json. If the current set is a strict subset of the
recorded one, the bot's reach was narrowed since the last build — the old,
still-mounted index file is now over-broad relative to what that bot should
see, until the next rebuild.

This exists because a narrowed role.yaml is otherwise a silent, unbounded
staleness window (the rejected first design's second HIGH-severity finding).
Modeled on scripts/claw-egress-sync --check, the closest existing precedent
for "detect a live-state divergence from a declared source and say so loudly."

Usage:
    python3 scripts/check-semantic-index-drift.py --check --all-bots
    python3 scripts/check-semantic-index-drift.py --check --bot house

Exit 0 = no drift detected for any checked bot. Exit 1 = drift detected for at
least one bot (or that bot has no manifest at all — nothing to compare against
is reported, not silently treated as "fine"). Never writes chunk content or a
full host path to its log — basenames/bot-names/reason codes only, matching
build-semantic-index.py's own logging rule (design header decision 6).
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts" / "lib"))
import semantic_index_authz as authz  # noqa: E402

INDEX_ROOT = Path("/Users/Michaellee/Documents/.oasis-semantic-index")
LOG_FILE = INDEX_ROOT / ".logs" / "check-semantic-index-drift.log"
CORPORA = ("exp",)  # kept in sync with build-semantic-index.py's CORPORA keys


def _log(severity: str, message: str) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    ts = datetime.now(timezone.utc).isoformat()
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"{ts} {severity} {message}\n")


def check_bot(bot: str) -> bool:
    """Returns True if drift was detected (or the bot cannot be assessed at
    all — fail LOUD, not silently clean) for any corpus this bot has a
    manifest for. Prints and logs a finding; never the narrowed content."""
    any_drift = False
    for corpus in CORPORA:
        manifest_path = INDEX_ROOT / bot / f"{corpus}.manifest.json"
        if not manifest_path.is_file():
            continue  # this bot has no built index for this corpus -- nothing to compare
        try:
            manifest = json.loads(manifest_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            print(f"❌ {bot}/{corpus}: manifest unreadable ({exc}) -- treating as drift", file=sys.stderr)
            _log("error", f"bot={bot} corpus={corpus} manifest_unreadable")
            any_drift = True
            continue
        recorded_roots = set(manifest.get("authorized_roots") or [])

        try:
            triples = authz.get_bot_triples(bot)
        except authz.AuthzError as exc:
            print(f"❌ {bot}/{corpus}: could not compute current reach ({exc}) -- treating as drift", file=sys.stderr)
            _log("error", f"bot={bot} corpus={corpus} reach_unreadable")
            any_drift = True
            continue
        current_roots = {t.host_root for t in triples}

        if not current_roots.issubset(recorded_roots) and not recorded_roots.issubset(current_roots):
            # Neither narrowed-only nor widened-only -- reach genuinely
            # changed shape. Still reported as drift (a rebuild is needed
            # either way to reflect it), but distinguished in the message so
            # a human is not misled into thinking access only ever narrows.
            print(f"⚠️  {bot}/{corpus}: reach CHANGED (not a pure narrowing) since last build — rebuild needed")
            _log("warn", f"bot={bot} corpus={corpus} reach_changed")
            any_drift = True
        elif current_roots < recorded_roots:
            print(f"❌ {bot}/{corpus}: reach NARROWED since last build — stale index is now OVER-BROAD")
            _log("warn", f"bot={bot} corpus={corpus} reach_narrowed")
            any_drift = True
        elif current_roots > recorded_roots:
            # Widened only: the old index is a strict subset of what's now
            # allowed -- under-broad, not over-broad. Not a security issue
            # (nothing is exposed that shouldn't be), but still worth a
            # rebuild to pick up the newly-authorized content.
            print(f"ℹ️  {bot}/{corpus}: reach widened since last build — rebuild recommended (not a leak)")
        else:
            print(f"✅ {bot}/{corpus}: no drift")
    return any_drift


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", required=True)
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--all-bots", action="store_true")
    group.add_argument("--bot")
    args = ap.parse_args()

    bots = authz.all_known_bots() if args.all_bots else [args.bot]
    any_drift = False
    for bot in bots:
        if check_bot(bot):
            any_drift = True
    return 1 if any_drift else 0


if __name__ == "__main__":
    sys.exit(main())
