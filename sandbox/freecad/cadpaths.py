"""Pure helpers for the oasis-freecad sidecar (CLAW-117).

No FreeCAD, no MCP, no network: everything here is a function of its
arguments, so the storage layout and the memory arithmetic are unit-tested
without a container (tests/test_cadpaths.py).

The storage layout is the contract with Mike's Mac. ButterBolt's FreeCAD
writes ONLY under CAD_ROOT, and that directory is a bind mount of
oasis-hardware/Product Design/ButterBolt, so every saved file is a normal file
in the repository that the Mac's FreeCAD 1.1.1 opens directly:

    Product Design/ButterBolt/
      <project>/                    lowercase-hyphen slug, one per design job
        README.md                   what, why, spec source, status (ButterBolt writes it)
        <part>.FCStd                parametric source of truth
        exports/<part>.step         interchange copy for other CAD tools
        exports/<part>.stl          only when a print is the goal
      _recovery/<UTC stamp>/        idle-reaper copies of unsaved work (gitignored)
"""

from __future__ import annotations

import json
import os
import re
from pathlib import PurePosixPath

PROJECT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
PART_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
EXPORT_KINDS = ("step", "stl")
JSON_MARKER = "OASIS_JSON:"


class LayoutError(ValueError):
    """A name or path that would put a file outside the agreed layout."""


def check_project(project: str) -> str:
    if not isinstance(project, str) or not PROJECT_RE.match(project):
        raise LayoutError(
            f"project {project!r} must be a lowercase slug: letters, digits and "
            "hyphens, 1-63 characters, for example 'scd41-enclosure'"
        )
    return project


def check_part(part: str) -> str:
    if not isinstance(part, str) or not PART_RE.match(part) or ".." in part:
        raise LayoutError(
            f"part name {part!r} must be 1-80 characters of letters, digits, '_', "
            "'-' or '.', with no extension, for example 'lid_v2'"
        )
    lowered = part.lower()
    for ext in (".fcstd", ".step", ".stp", ".stl"):
        if lowered.endswith(ext):
            raise LayoutError(f"part name {part!r} must not carry an extension")
    return part


def part_from_doc_name(doc_name: str) -> str:
    """Default part name: the FreeCAD document name, made layout-safe."""
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", doc_name or "").strip("._-")
    return check_part(cleaned[:80] or "part")


def design_paths(cad_root: str, project: str, part: str) -> dict[str, str]:
    """Absolute container paths for one part of one project."""
    root = PurePosixPath(cad_root)
    proj = root / check_project(project)
    name = check_part(part)
    return {
        "project_dir": str(proj),
        "fcstd": str(proj / f"{name}.FCStd"),
        "step": str(proj / "exports" / f"{name}.step"),
        "stl": str(proj / "exports" / f"{name}.stl"),
    }


def check_exports(kinds) -> list[str]:
    kinds = list(kinds or [])
    bad = [k for k in kinds if k not in EXPORT_KINDS]
    if bad:
        raise LayoutError(f"unknown export kind(s) {bad}; use {list(EXPORT_KINDS)}")
    return sorted(set(kinds), key=EXPORT_KINDS.index)


def is_within(path: str, root: str) -> bool:
    """True when `path` resolves inside `root` (lexically; no symlink follow)."""
    p = os.path.normpath(path)
    r = os.path.normpath(root)
    return p == r or p.startswith(r.rstrip("/") + "/")


def check_readable(path: str, roots: list[str]) -> str:
    """Refuse an open_design path outside the read roots."""
    if not isinstance(path, str) or not path.startswith("/"):
        raise LayoutError(f"path {path!r} must be absolute, for example "
                          "'/reach/oasis-hardware/Product Design/...'")
    norm = os.path.normpath(path)
    if not any(is_within(norm, r) for r in roots):
        raise LayoutError(f"path {path!r} is outside the readable roots {roots}")
    if not norm.lower().endswith((".fcstd", ".step", ".stp")):
        raise LayoutError(f"path {path!r} must be a .FCStd, .step or .stp file")
    return norm


def host_path(container_path: str, container_root: str, host_root: str) -> str | None:
    """Map a container path under container_root to the Mac path, if configured."""
    if not host_root or not is_within(container_path, container_root):
        return None
    rel = os.path.relpath(os.path.normpath(container_path), os.path.normpath(container_root))
    return host_root.rstrip("/") + ("" if rel == "." else "/" + rel)


def recovery_dir(cad_root: str, stamp: str) -> str:
    return str(PurePosixPath(cad_root) / "_recovery" / stamp)


def parse_marked_json(message: str):
    """Pull the JSON payload a FreeCAD-side snippet printed after JSON_MARKER.

    The addon returns stdout inside a free-text message ("... Output: <stdout>"),
    so snippets print one marked line and this reads the LAST one.
    """
    if not isinstance(message, str):
        return None
    found = None
    for line in message.splitlines():
        idx = line.find(JSON_MARKER)
        if idx != -1:
            found = line[idx + len(JSON_MARKER):]
    if found is None:
        return None
    try:
        return json.loads(found)
    except json.JSONDecodeError:
        return None


# ── memory arithmetic ────────────────────────────────────────────────────────

def parse_vmrss_kb(status_text: str) -> int:
    """VmRSS in kB from /proc/<pid>/status text (0 when absent, e.g. a zombie)."""
    for line in status_text.splitlines():
        if line.startswith("VmRSS:"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                return int(parts[1])
    return 0


def parse_stat_session(stat_text: str) -> int | None:
    """Session id (field 6) from /proc/<pid>/stat.

    The command name (field 2) is parenthesised and may contain spaces or
    parentheses, so split after the LAST ')'.
    """
    end = stat_text.rfind(")")
    if end == -1:
        return None
    rest = stat_text[end + 1:].split()
    # rest[0]=state, [1]=ppid, [2]=pgrp, [3]=session
    if len(rest) < 4 or not rest[3].lstrip("-").isdigit():
        return None
    return int(rest[3])


def parse_cgroup_bytes(text: str) -> int | None:
    """cgroup v2 memory.current / memory.max value; None for 'max' (no limit)."""
    value = (text or "").strip()
    if not value or value == "max":
        return None
    return int(value) if value.isdigit() else None


def memory_pressure(used: int | None, limit: int | None, threshold: float = 0.8) -> bool:
    if not used or not limit:
        return False
    return used >= threshold * limit
