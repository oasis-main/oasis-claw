#!/usr/bin/env python3
"""Required self-test for the semantic-index nested-shield exclusion procedure.

CLAW-094 (round 3 final design, section 1). This asserts, against House's REAL
role.yaml, that the two-step authorization procedure correctly excludes House's
own reviewer policy — the exact case the rejected round-2 prose rule would have
gotten wrong (a naive "is P contained under the shadow's own host root" check
answers "no shadow applies" for an EMPTY shield directory, since nothing is
contained under an empty directory, and incorrectly re-admits P).

scripts/build-semantic-index.py runs this exact assertion in-process, as its
first action, whenever the corpus root it is about to walk is
/Users/Michaellee/Documents/Runes/oasis-x or any path under it, and exits
non-zero before touching a single corpus file if it fails. It does not need to
run for the current corpus (/reach/exp never overlaps the shield), which is
exactly why an automatic, unconditional guard matters here rather than a
one-time manual check someone has to remember to run again later.

Run directly:  python3 scripts/tests/test_nested_shield_exclusion.py
Exit 0 = pass, exit 1 = fail (never a fallback to "assume it's fine").
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts" / "lib"))
import semantic_index_authz as authz  # noqa: E402


def assert_house_shield_excludes_own_reviewer_policy() -> None:
    triples = authz.get_bot_triples("house")

    shield_admitting = [t for t in triples if t.at_path == "/reach/oasis-x/oasis-claw"]
    shield_broad = [t for t in triples if t.at_path == "/reach/oasis-x"]
    if not shield_admitting or not shield_broad:
        raise AssertionError(
            "House's role.yaml no longer declares the expected shield pair "
            "(/reach/oasis-x broad + /reach/oasis-x/oasis-claw shield) — "
            "this test's premise has changed; update it, do not skip it."
        )

    target = os.path.realpath(
        str(REPO_ROOT / "bots" / ".runtime" / "reviewer-policy.json")
    )
    authorized, admitting = authz.resolve_authorization(triples, target)

    assert authorized is False, (
        "REGRESSION: the nested-shield procedure would authorize House to see "
        f"its own reviewer-policy.json ({target}) through the broad "
        "/reach/oasis-x mount, defeating the empty-directory shield that "
        "exists specifically to prevent this. A naive 'is P contained under "
        "the SHADOW's own host root' check produces exactly this failure for "
        "an empty shield directory — see this file's module docstring."
    )
    assert admitting is None, "excluded path must not carry an admitting triple"


def assert_yesman_legitimate_remount_is_not_treated_as_a_shield() -> None:
    """The negative control. Yes Man's deeper /reach/runes/oasis-x/oasis-claw
    mount re-mounts the SAME real directory at a narrower container path — a
    legitimate nested remount, not a shield. The procedure must NOT exclude
    it; an over-eager fix for the House case that excludes every deeper
    mount unconditionally would silently break this bot's real, intended
    access, trading one bug for another."""
    triples = authz.get_bot_triples("yesman")
    target = os.path.realpath(str(REPO_ROOT / "scripts" / "claw-vet"))
    authorized, admitting = authz.resolve_authorization(triples, target)
    assert authorized is True, (
        "REGRESSION: Yes Man's legitimate nested remount of oasis-claw is "
        "being excluded as if it were a shield. The shadow test must "
        "distinguish 'deeper mount serves DIFFERENT content' (exclude) from "
        "'deeper mount re-serves the SAME real content at a narrower path' "
        "(keep authorized) — see resolve_authorization's Step 2."
    )
    assert admitting is not None


def assert_tie_break_prefers_more_specific_host_root() -> None:
    """Synthetic case (round 3 recheck-partial-overlap-and-blast-radius): no
    real bot's triple set produces this tie today, but the two-step
    procedure must still resolve it deterministically and correctly rather
    than depending on Python dict/list ordering, which is not a security
    property.

    A genuine tie needs two DIFFERENT at_paths of equal depth, each ancestor
    of P via a DIFFERENT, nested host_root — not two triples sharing the same
    at_path (that is a degenerate/invalid compose config, not a tie, and
    exercises Step 2's shadow detection instead of Step 1's tie-break)."""
    outer = authz.Triple(host_root="/tmp/claw-authz-test/a", at_path="/reach/one", mode="ro")
    inner = authz.Triple(host_root="/tmp/claw-authz-test/a/b", at_path="/reach/two", mode="ro")
    triples = [outer, inner]
    p = "/tmp/claw-authz-test/a/b/c/file.txt"
    authorized, admitting = authz.resolve_authorization(triples, p)
    assert authorized is True
    assert admitting is inner, (
        "tie-break must select the MOST SPECIFIC (longest) host_root among "
        "candidates tied for shallowest at_path depth"
    )


def main() -> int:
    checks = [
        assert_house_shield_excludes_own_reviewer_policy,
        assert_yesman_legitimate_remount_is_not_treated_as_a_shield,
        assert_tie_break_prefers_more_specific_host_root,
    ]
    failed = 0
    for check in checks:
        try:
            check()
        except authz.AuthzError as exc:
            print(f"FAIL (could not compute reach): {check.__name__}: {exc}", file=sys.stderr)
            failed += 1
        except AssertionError as exc:
            print(f"FAIL: {check.__name__}: {exc}", file=sys.stderr)
            failed += 1
        else:
            print(f"PASS: {check.__name__}")
    if failed:
        print(f"\n{failed} check(s) FAILED — refusing to proceed", file=sys.stderr)
        return 1
    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
