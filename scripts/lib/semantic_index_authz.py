"""Shared authorization core for the per-bot semantic search index (CLAW-094).

Three scripts need the IDENTICAL answer to "which host paths may bot B see":
build-semantic-index.py (to decide what goes in a bot's own file),
check-semantic-index-drift.py (to detect a role.yaml narrowing after the last
build), and tests/test_nested_shield_exclusion.py (the required self-test).
Implementing the two-step exclusion procedure three times is exactly the kind
of drift that let oasis-find's own deny-glob list and reviewer-policy.json's
copy disagree silently for months — this module exists so there is one
implementation, imported everywhere, never re-derived.

Ground truth for a bot's reach comes from `compile-role.py --emit-reach-compose`,
never from re-parsing role.yaml's `reach:` block directly — that generator's
output is what Docker actually mounts, so reading it (rather than writing a
second role.yaml parser) makes this module's authorization set structurally
unable to drift from what a bot's container really has.

Design doc: CLAW-094 final design (round 3), sections 1 and 2.
"""

from __future__ import annotations

import dataclasses
import json
import os
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("FATAL: python3-yaml not installed", file=sys.stderr)
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
COMPILE_ROLE = REPO_ROOT / "scripts" / "compile-role.py"
BOTS_DIR = REPO_ROOT / "bots"

# Bots with a real role.yaml -> compile-role.py --emit-reach-compose chain.
ROLE_YAML_BOTS = ("house", "kolmogorov", "yesman", "vanhelsing", "butterbolt")

# Nimbus is the base `openclaw` service, not a bots/ service — no role.yaml
# exists for it (confirmed: no bots/nimbus/ directory). Its reach comes only
# from this overlay, which IS already the "compiled" artifact — there is no
# upstream role.yaml to compile it from, so it is read directly instead of
# going through compile-role.py.
NIMBUS_REACH_OVERLAY = BOTS_DIR / "docker-compose.nimbus-reach.yml"

# Hello World's role.yaml is CONFIRMED STALE (verified 2026-08 against the
# real bots/docker-compose.bots.yml: it lists oasis-cloud-admin, oasis-cloud,
# and Knowledge reads that a 2026-07-29 comment there states were REMOVED).
# compile-role.py cannot regenerate an accurate answer for it, because there
# is deliberately no docker-compose.hello-world-reach.yml overlay (that
# filename would trigger auto-sandboxing, and Hello World must keep broad
# egress). This table is a KNOWN-RISK, HAND-MAINTAINED mechanism — the exact
# weakest link the rejected first design's own section 8(e) named — carried
# forward, not solved, and scoped today to this one bot only. If the real
# compose file changes, this table goes stale silently until a human re-checks
# it; nothing in this codebase currently detects that automatically.
KNOWN_OVERRIDES: dict[str, list["Triple"]] = {
    "hello-world": [
        # Verified 2026-08 against bots/docker-compose.bots.yml.
    ],
}


@dataclasses.dataclass(frozen=True)
class Triple:
    """One (host_root, at_path, mode) reach entry, host_root realpath-resolved."""

    host_root: str
    at_path: str
    mode: str  # "ro" | "rw"


class AuthzError(Exception):
    """Raised when a bot's reach cannot be computed at all (fail closed)."""


def _run_compile_role(bot: str) -> dict:
    role_path = BOTS_DIR / bot / "role.yaml"
    if not role_path.is_file():
        raise AuthzError(f"no role.yaml for bot {bot!r} at {role_path}")
    proc = subprocess.run(
        [sys.executable, str(COMPILE_ROLE), "--emit-reach-compose", str(role_path)],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        raise AuthzError(f"compile-role.py failed for {bot!r}: {proc.stderr.strip()}")
    try:
        return yaml.safe_load(proc.stdout) or {}
    except yaml.YAMLError as exc:
        raise AuthzError(f"compile-role.py output for {bot!r} did not parse: {exc}") from exc


def _triples_from_compose_dict(bot: str, compose: dict) -> list[Triple]:
    """Parse the `volumes:` short-form list a reach-compose emit produces.

    Each entry is one of:
      "<host>:<at>:<mode>"   a host bind mount (what we want)
      "<name>:<at>"          a named volume (no host path -> skip, no
                              host-canonical path exists to compare)
    The role.yaml self-mount ("<abs_role.yaml>:/app/role.yaml:ro") is excluded
    on purpose: it is metadata about the bot, not a reach grant, and treating
    it as one would authorize a bot for ITS OWN role.yaml file's real path —
    never a meaningful corpus location, but worth excluding structurally
    rather than relying on it never overlapping a future corpus by accident.
    """
    svc = ((compose.get("services") or {}).get(bot)) or {}
    raw_volumes = svc.get("volumes") or []
    triples: list[Triple] = []
    for entry in raw_volumes:
        if not isinstance(entry, str):
            continue
        parts = entry.split(":")
        if len(parts) < 2:
            continue
        if entry.endswith(":/app/role.yaml:ro"):
            continue  # the bot's own role.yaml mount, not a reach grant
        if len(parts) == 2:
            continue  # named volume: "<name>:<at>", no host path to compare
        host, at, mode = parts[0], parts[1], parts[2]
        if not host.startswith("/"):
            continue  # defensive: a genuine host bind is always absolute
        try:
            real_host = os.path.realpath(host)
        except OSError:
            continue
        triples.append(Triple(host_root=real_host, at_path=at, mode=mode if mode == "rw" else "ro"))
    return triples


def get_bot_triples(bot: str) -> list[Triple]:
    """The bot's full, CURRENT (host_root, at_path, mode) list. Fails closed:
    raises AuthzError rather than returning an empty or partial list on any
    read/parse failure, so a caller cannot mistake "could not determine reach"
    for "this bot has no reach"."""
    if bot in KNOWN_OVERRIDES:
        return list(KNOWN_OVERRIDES[bot])
    if bot == "nimbus":
        if not NIMBUS_REACH_OVERLAY.is_file():
            raise AuthzError(f"missing {NIMBUS_REACH_OVERLAY}")
        try:
            compose = yaml.safe_load(NIMBUS_REACH_OVERLAY.read_text()) or {}
        except yaml.YAMLError as exc:
            raise AuthzError(f"{NIMBUS_REACH_OVERLAY} did not parse: {exc}") from exc
        return _triples_from_compose_dict("openclaw", compose)
    if bot not in ROLE_YAML_BOTS:
        raise AuthzError(f"unknown bot {bot!r} — not in ROLE_YAML_BOTS, KNOWN_OVERRIDES, or nimbus")
    compose = _run_compile_role(bot)
    return _triples_from_compose_dict(bot, compose)


def all_known_bots() -> list[str]:
    return sorted(set(ROLE_YAML_BOTS) | set(KNOWN_OVERRIDES) | {"nimbus"})


def _depth(at_path: str) -> int:
    return len([seg for seg in at_path.split("/") if seg])


def _is_ancestor(root: str, p: str) -> bool:
    return p == root or p.startswith(root.rstrip("/") + os.sep)


def _relative(root: str, p: str) -> str:
    return os.path.relpath(p, root)


def _strip_prefix(container_path: str, prefix: str) -> str:
    rest = container_path[len(prefix):]
    return rest.lstrip("/")


def resolve_authorization(triples: list[Triple], p: str) -> tuple[bool, Triple | None]:
    """The two-step nested-shield-aware procedure. p must already be an
    os.path.realpath()-resolved host path (callers realpath it once per file,
    not once per bot per file, for cost reasons — see build-semantic-index.py).

    Returns (authorized, admitting_triple). admitting_triple is the triple
    whose at_path a caller should use to translate p into this bot's own
    container path convention; it is returned even when a *different* mode
    is implied by a legitimate deeper re-mount (Step 2's "same real content"
    branch), per the design's "use the deeper triple's mode if it differs"
    rule — callers needing the effective mode should re-derive it themselves
    from the returned triple plus the original candidates if that distinction
    matters to them; this function's job is authorization, not mode resolution.
    """
    candidates = [t for t in triples if _is_ancestor(t.host_root, p)]
    if not candidates:
        return False, None

    # Step 1: shallowest at_path wins; tie -> most specific (longest) host_root.
    # The tie-break is the one gap found and closed across three adversarial
    # review rounds (recheck-partial-overlap-and-blast-radius) — it cannot
    # fire for any bot's real triple set today (verified by the self-test),
    # but a naive "first match wins" implementation would be a live bug the
    # moment two candidates ever do tie.
    admitting = min(candidates, key=lambda t: (_depth(t.at_path), -len(t.host_root)))
    derived_container_path = admitting.at_path.rstrip("/") + "/" + _relative(admitting.host_root, p)
    derived_container_path = derived_container_path.replace("/./", "/").rstrip("/") or "/"

    # Step 2: deepest OTHER triple whose at_path prefixes the derived path.
    shadow_candidates = [
        t for t in triples
        if t is not admitting
        and (derived_container_path == t.at_path or derived_container_path.startswith(t.at_path.rstrip("/") + "/"))
    ]
    if not shadow_candidates:
        return True, admitting

    shadow = max(shadow_candidates, key=lambda t: _depth(t.at_path))
    implied_host_path = os.path.join(shadow.host_root, _strip_prefix(derived_container_path, shadow.at_path))
    try:
        same = os.path.realpath(implied_host_path) == os.path.realpath(p)
    except OSError:
        same = False
    if same:
        return True, admitting  # legitimate nested re-mount, not a shield
    return False, None  # shadow serves DIFFERENT content -> excluded


def to_bot_container_path(admitting: Triple, p: str) -> str:
    """Translate a realpath-resolved host path into this bot's own container
    path convention, using the SAME admitting triple resolve_authorization
    used to grant access — never a second, independently-derived mapping."""
    return admitting.at_path.rstrip("/") + "/" + _relative(admitting.host_root, p)
