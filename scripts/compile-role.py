#!/usr/bin/env python3
"""Compile a bot's role.yaml into shell exports consumed by the entrypoint.

Usage: compile-role.py <role.yaml>
Output: shell `export` lines on stdout, safe for `eval "$(...)"`

The compiler resolves the ACTIVE exec tier based on the `phase` field —
dormant tiers are logged but not compiled into the allowlist. This is
the mechanism that lets role.yaml carry the FULL role definition while
the running bot only gets the slice appropriate to its current phase.

CLAW-047 — safe-auto-mode onboarding via role-manifest compiler.
"""

import json
import os
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("FATAL: python3-yaml not installed — cannot compile role.yaml",
          file=sys.stderr)
    sys.exit(1)


def _sq(s):
    """Single-quote a string for safe shell eval (POSIX)."""
    return "'" + s.replace("'", "'\\''") + "'"


def compile_role(role_path):
    raw = Path(role_path).read_text()
    data = yaml.safe_load(raw)
    if not isinstance(data, dict):
        print(f"FATAL: {role_path} top-level value is not a mapping",
              file=sys.stderr)
        sys.exit(1)

    phase = str(data.get("phase", "")).strip()
    role = str(data.get("role", "")).strip()

    exports = []
    exports.append(f"export OASIS_ROLE_NAME={_sq(role)}")
    exports.append(f"export OASIS_ROLE_PHASE={_sq(phase)}")

    # ── Layer 1: tools ────────────────────────────────────────────────
    tools = data.get("tools") or {}
    if isinstance(tools, dict):
        profile = tools.get("profile")
        if profile:
            exports.append(f"export OASIS_TOOLS_PROFILE={_sq(str(profile))}")
        also_allow = tools.get("alsoAllow") or []
        if isinstance(also_allow, list) and also_allow:
            exports.append(
                f"export OASIS_TOOLS_ALSO_ALLOW="
                f"{_sq(','.join(str(x) for x in also_allow))}"
            )

    # ── Layer 2: exec (ACTIVE tier only) ──────────────────────────────
    exec_cfg = data.get("exec") or {}
    if isinstance(exec_cfg, dict):
        active = exec_cfg.get("allow") or []
        if isinstance(active, list):
            patterns = [str(x).strip() for x in active if str(x).strip()]
            exports.append(
                f"export OASIS_EXEC_ALLOWLIST={_sq(chr(10).join(patterns))}"
            )
            exports.append(f"export _ROLE_EXEC_ACTIVE_COUNT={len(patterns)}")

        dormant = exec_cfg.get("dormant") or {}
        if isinstance(dormant, dict):
            tier_names = sorted(dormant.keys())
            dormant_count = sum(
                len(v) if isinstance(v, list) else 0
                for v in dormant.values()
            )
            exports.append(f"export _ROLE_EXEC_DORMANT_COUNT={dormant_count}")
            exports.append(
                f"export _ROLE_EXEC_DORMANT_TIERS="
                f"{_sq(','.join(tier_names))}"
            )

    # ── Layers 3+4: origins ───────────────────────────────────────────
    origins = data.get("origins") or {}
    if isinstance(origins, dict):
        trusted = origins.get("trusted") or []
        if isinstance(trusted, list):
            exports.append(
                f"export OASIS_ORIGINS_TRUSTED="
                f"{_sq(chr(10).join(str(x) for x in trusted))}"
            )
            exports.append(
                f"export _ROLE_ORIGINS_TRUSTED_COUNT={len(trusted)}"
            )
        candidates = origins.get("candidates") or []
        if isinstance(candidates, list):
            exports.append(
                f"export _ROLE_ORIGINS_CANDIDATES="
                f"{_sq(chr(10).join(str(x) for x in candidates))}"
            )
        exclude = origins.get("exclude") or []
        if isinstance(exclude, list):
            exports.append(
                f"export _ROLE_ORIGINS_EXCLUDE="
                f"{_sq(chr(10).join(str(x) for x in exclude))}"
            )

    # ── reach (filesystem blast radius — metadata only here) ──────────
    # The actual bind-mounts are rendered into the bot's compose overlay by
    # --emit-reach-compose (Docker can't hot-add a mount to a running container,
    # so reach changes need a recreate). Here we only export a boot-log summary.
    reach = data.get("reach") or {}
    if isinstance(reach, dict):
        reads = reach.get("read") or []
        wvols = reach.get("write_volumes") or []
        if isinstance(reads, list):
            exports.append(f"export _ROLE_REACH_READ_COUNT={len(reads)}")
        if isinstance(wvols, list):
            exports.append(f"export _ROLE_REACH_WRITE_COUNT={len(wvols)}")

    # ── task_scope ────────────────────────────────────────────────────
    task_scope = data.get("task_scope")
    if task_scope and str(task_scope).strip():
        exports.append(
            f"export OASIS_TASK_SCOPE={_sq(str(task_scope).strip())}"
        )

    print("\n".join(exports))


def _load(role_path):
    data = yaml.safe_load(Path(role_path).read_text())
    if not isinstance(data, dict):
        print(f"FATAL: {role_path} top-level value is not a mapping",
              file=sys.stderr)
        sys.exit(1)
    return data


def emit_egress_allowlist(role_path):
    """Emit origins.trusted in egress-proxy allowlist.txt format (stdout).

    ONLY origins.trusted is emitted — the vetted, allow-by-default hosts.
    origins.candidates are deliberately EXCLUDED: they are vetting CANDIDATES,
    not allowlist entries, and auto-allowing them would defeat the first-visit
    vetting gate (CLAW-034). Run this in a TRUSTED context (build / make / init
    step) to render the proxy's static seed — NEVER from the sandboxed bot,
    which must not be able to author its own egress policy.
    """
    data = _load(role_path)
    role = str(data.get("role", "")).strip()
    phase = str(data.get("phase", "")).strip()
    origins = data.get("origins") or {}
    trusted = origins.get("trusted") or [] if isinstance(origins, dict) else []
    lines = [
        "# egress allowlist — compiled from role.yaml origins.trusted",
        f"# role={role} phase={phase}",
        "# candidates are NOT included — they require first-visit vetting (CLAW-034)",
    ]
    for t in trusted:
        t = str(t).strip()
        if t:
            lines.append(t)
    print("\n".join(lines))


def _bot_name(role_path, data):
    """Compose service name = explicit role.yaml `bot:` else the parent dir name
    (bots/<bot>/role.yaml → <bot>). Matches the service names in bots/docker-compose.bots.yml."""
    return str(data.get("bot") or Path(role_path).resolve().parent.name).strip()


def emit_reach_compose(role_path):
    """Render the bot's FILESYSTEM reach into a compose overlay supplement (stdout).

    role.yaml `reach:` is the declarative source of the filesystem blast radius;
    this generator renders it into the per-bot service's `volumes:` — safe by
    construction: every host bind is emitted READ-ONLY (:ro — the reach model is
    narrowest-dir RO), the role.yaml mount is absolute (a bare relative source is
    mis-parsed by compose as a named volume), and write surfaces are container-only
    named volumes, never host binds. Docker cannot hot-add a mount, so applying a
    reach change means recreating that one bot (the egress half hot-reloads; the
    filesystem half does not). Run in a TRUSTED context — never the sandboxed bot.

    reach:
      read:            # host bind-mounts; :ro by default, `mode: rw` opt-in (trusted bot)
        - { host: /abs/host/path, at: /reach/name }
        - { host: /abs/writable, at: /reach/rw, mode: rw }
      write_volumes:   # container-only named volumes (never host binds)
        - { name: <bot>_work, at: /work }
      sandbox_ip: 10.x.y.z   # optional — static IP for CLAW-050 egress partitioning
    """
    data = _load(role_path)
    bot = _bot_name(role_path, data)
    abs_role = str(Path(role_path).resolve())
    reach = data.get("reach") or {}
    reads = reach.get("read") or [] if isinstance(reach, dict) else []
    wvols = reach.get("write_volumes") or [] if isinstance(reach, dict) else []
    sandbox_ip = str(reach.get("sandbox_ip") or "").strip() if isinstance(reach, dict) else ""

    vols = [f"{abs_role}:/app/role.yaml:ro"]   # the manifest itself is ALWAYS ro
    for r in reads:
        host = str(r.get("host", "")).strip()
        at = str(r.get("at", "")).strip()
        # Default READ-ONLY (the reach model); `mode: rw` is opt-in, for the
        # trusted-broad systems bot (Yes Man) that APPLIES changes. Anything not
        # explicitly "rw" is forced to ":ro" — a typo can only ever be safer.
        mode = "rw" if str(r.get("mode", "ro")).strip().lower() == "rw" else "ro"
        if host and at:
            vols.append(f"{host}:{at}:{mode}")
    for w in wvols:
        name = str(w.get("name", "")).strip()
        at = str(w.get("at", "")).strip()
        if name and at:
            vols.append(f"{name}:{at}")

    svc = {"volumes": vols}
    if sandbox_ip:
        svc["networks"] = {"oasis_sandboxed": {"ipv4_address": sandbox_ip}}
    overlay = {"services": {bot: svc}}
    named = {w["name"]: {"name": w["name"]}
             for w in wvols if isinstance(w, dict) and str(w.get("name", "")).strip()}
    if named:
        overlay["volumes"] = named

    header = (
        f"# GENERATED by compile-role.py --emit-reach-compose from "
        f"{Path(role_path).as_posix()}\n"
        f"# Filesystem blast radius (CLAW-047 reach) for '{bot}'. Regenerate on change;\n"
        f"# do NOT hand-edit mounts here — edit role.yaml `reach:` and re-emit. Every\n"
        f"# host bind is READ-ONLY by construction. Applying a change requires recreating\n"
        f"# this one bot (Docker can't hot-add a mount).\n"
    )
    print(header + yaml.dump(overlay, sort_keys=False, default_flow_style=False), end="")


def emit_vetting_hints(role_path):
    """Emit origins.candidates, one per line (stdout).

    These are the vetter's PRIMING list — likely-needed origins to pre-vet — and
    are NOT allowlist entries. A candidate only becomes reachable after the
    vetting service passes it (learned store) or Mike promotes it into
    origins.trusted via the graduation loop (CLAW-048).
    """
    data = _load(role_path)
    origins = data.get("origins") or {}
    candidates = origins.get("candidates") or [] if isinstance(origins, dict) else []
    for c in candidates:
        c = str(c).strip()
        if c:
            print(c)


if __name__ == "__main__":
    args = sys.argv[1:]
    mode = "exports"
    if args and args[0].startswith("--"):
        flag = args.pop(0)
        mode = {
            "--emit-egress-allowlist": "egress",
            "--emit-vetting-hints": "hints",
            "--emit-reach-compose": "reach",
        }.get(flag)
        if mode is None:
            print(f"Unknown flag: {flag}", file=sys.stderr)
            sys.exit(2)
    if len(args) != 1:
        print(f"Usage: {sys.argv[0]} "
              f"[--emit-egress-allowlist|--emit-vetting-hints|--emit-reach-compose] "
              f"<role.yaml>",
              file=sys.stderr)
        sys.exit(1)
    role_file = args[0]
    if not Path(role_file).is_file():
        print(f"FATAL: {role_file} not found", file=sys.stderr)
        sys.exit(1)
    if mode == "egress":
        emit_egress_allowlist(role_file)
    elif mode == "hints":
        emit_vetting_hints(role_file)
    elif mode == "reach":
        emit_reach_compose(role_file)
    else:
        compile_role(role_file)
