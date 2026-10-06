"""oasis-freecad — ButterBolt's own FreeCAD, in its own container (CLAW-117).

WHY A SEPARATE CONTAINER: the FreeCAD MCP `execute_code` tool runs any Python
inside the FreeCAD process. On Mike's Mac that is code execution as Mike. Here
it is code execution inside a container that has no internet, no credentials,
no Docker socket, a memory ceiling, and exactly one writable host directory
(oasis-hardware/Product Design/ButterBolt). See .swarm/CLAW-117_BUTTERBOLT_FREECAD.md.

What this server adds to the upstream tool set (neka-nat/freecad-mcp):
  * lifecycle  — FreeCAD starts on the first tool call and stops after
                 OASIS_FREECAD_IDLE_SECONDS without a call, so an idle bot
                 holds no FreeCAD memory at all.
  * memory     — freecad_status reports process RSS and the container's cgroup
                 usage; freecad_cleanup closes documents and stops FreeCAD.
  * storage    — save_design writes only into the agreed layout (cadpaths.py)
                 and exports STEP/STL beside the FCStd.
  * no implicit screenshots — upstream grabs a screenshot after EVERY call,
                 which costs time, re-orients the view, and fills the bot's
                 context with images. Here only get_view returns an image.

Transport: MCP streamable-http on the internal `oasis_cad` network. FreeCAD's
own XML-RPC server listens on 127.0.0.1 inside this container only.
"""

from __future__ import annotations

import datetime
import functools
import json
import logging
import os
import signal
import subprocess
import threading
import time
import xmlrpc.client
from contextlib import contextmanager
from typing import Literal

from mcp.server.fastmcp import FastMCP
from mcp.types import ImageContent, TextContent

import freecad_mcp.server as upstream

import cadpaths

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("oasis-freecad")


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        log.warning("%s=%r is not an integer; using %s", name, raw, default)
        return default


FREECAD_BIN = os.environ.get("OASIS_FREECAD_BIN", "/opt/freecad/AppRun")
DISPLAY = os.environ.get("OASIS_FREECAD_DISPLAY", ":99")
SCREEN = os.environ.get("OASIS_FREECAD_SCREEN", "1280x960x24")
RPC_PORT = _env_int("OASIS_FREECAD_RPC_PORT", 9875)
MCP_HOST = os.environ.get("OASIS_FREECAD_MCP_HOST", "0.0.0.0")
MCP_PORT = _env_int("OASIS_FREECAD_MCP_PORT", 8765)
CAD_ROOT = os.environ.get("OASIS_FREECAD_CAD_ROOT", "/reach/oasis-hardware/Product Design/ButterBolt")
READ_ROOTS = [r.strip() for r in os.environ.get(
    "OASIS_FREECAD_READ_ROOTS",
    "/reach/oasis-hardware/Product Design,/reach/oasis-hardware/cadgen",
).split(",") if r.strip()]
# Mac path of CAD_ROOT. Used only to tell Mike where a saved file is.
HOST_ROOT = os.environ.get("OASIS_FREECAD_HOST_ROOT", "")
IDLE_SECONDS = _env_int("OASIS_FREECAD_IDLE_SECONDS", 900)
START_TIMEOUT = _env_int("OASIS_FREECAD_START_TIMEOUT", 120)
CALL_TIMEOUT = _env_int("OASIS_FREECAD_CALL_TIMEOUT", 180)
VIEW_MAX_PX = _env_int("OASIS_FREECAD_VIEW_MAX_PX", 1024)
LOG_PATH = os.environ.get("OASIS_FREECAD_LOG", "/tmp/freecad.log")
FREECAD_HOME = os.environ.get("OASIS_FREECAD_HOME", "/home/cad")
ALLOWED_HOSTS = [h.strip() for h in os.environ.get(
    "OASIS_FREECAD_ALLOWED_HOSTS",
    f"oasis-freecad:{MCP_PORT},oasis-freecad,127.0.0.1:{MCP_PORT},localhost:{MCP_PORT}",
).split(",") if h.strip()]


# ── XML-RPC to FreeCAD, with a timeout ───────────────────────────────────────
# xmlrpc.client has no timeout knob; without one, a hung FreeCAD blocks the
# tool call (and the bot's turn) forever.

class _TimeoutTransport(xmlrpc.client.Transport):
    def __init__(self, timeout: float):
        super().__init__()
        self._timeout = timeout

    def make_connection(self, host):
        conn = super().make_connection(host)
        conn.timeout = self._timeout
        return conn


class Conn(upstream.FreeCADConnection):
    """Upstream connection with a timeout and without implicit screenshots."""

    def __init__(self, timeout: float = CALL_TIMEOUT):  # noqa: D107 — upstream __init__ skipped on purpose
        self.server = xmlrpc.client.ServerProxy(
            f"http://127.0.0.1:{RPC_PORT}", allow_none=True,
            transport=_TimeoutTransport(timeout),
        )

    def get_active_screenshot(self, *args, **kwargs):
        return None

    def screenshot(self, view_name, width, height, focus_object):
        return self.server.get_active_screenshot(view_name, width, height, focus_object)


# ── the FreeCAD process ──────────────────────────────────────────────────────

def _tail(path: str, lines: int = 25) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 8192))
            return "\n".join(f.read().decode("utf-8", "replace").splitlines()[-lines:])
    except OSError:
        return "(no log)"


def _read(path: str) -> str:
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


class FreeCADProcess:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._proc: subprocess.Popen | None = None
        self._xvfb: subprocess.Popen | None = None
        self._started: float | None = None
        self._busy = 0
        self.last_used = time.monotonic()

    # state ------------------------------------------------------------------
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def busy(self) -> int:
        return self._busy

    def uptime(self) -> float | None:
        return None if self._started is None or not self.running() else time.monotonic() - self._started

    def idle(self) -> float:
        return time.monotonic() - self.last_used

    def touch(self) -> None:
        self.last_used = time.monotonic()

    def rpc(self, timeout: float = CALL_TIMEOUT) -> Conn:
        return Conn(timeout)

    def _ping(self) -> bool:
        try:
            return bool(self.rpc(timeout=3).ping())
        except Exception:  # noqa: BLE001 — any failure means "not answering"
            return False

    # start / stop -------------------------------------------------------------
    def _ensure_xvfb(self) -> None:
        if self._xvfb is not None and self._xvfb.poll() is None:
            return
        self._xvfb = subprocess.Popen(
            ["Xvfb", DISPLAY, "-screen", "0", SCREEN, "-nolisten", "tcp"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
        )
        sock = f"/tmp/.X11-unix/X{DISPLAY.lstrip(':')}"
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not os.path.exists(sock):
            if self._xvfb.poll() is not None:
                raise RuntimeError(f"Xvfb exited with code {self._xvfb.returncode}")
            time.sleep(0.1)

    def _start_locked(self) -> None:
        self._ensure_xvfb()
        os.makedirs(FREECAD_HOME, exist_ok=True)
        env = dict(
            os.environ,
            DISPLAY=DISPLAY,
            HOME=FREECAD_HOME,
            QT_QPA_PLATFORM="xcb",
            LIBGL_ALWAYS_SOFTWARE="1",
            QTWEBENGINE_DISABLE_SANDBOX="1",
            QTWEBENGINE_CHROMIUM_FLAGS="--disable-gpu",
        )
        logf = open(LOG_PATH, "ab")  # noqa: SIM115 — owned by the child for its lifetime
        # NO positional arguments: FreeCAD treats them as documents to open.
        # That rule cost 30 hand-made FCStd files on 2026-06-12 (cadgen memory).
        self._proc = subprocess.Popen(
            [FREECAD_BIN], env=env, cwd=FREECAD_HOME,
            stdout=logf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
        logf.close()
        self._started = time.monotonic()
        deadline = self._started + START_TIMEOUT
        while time.monotonic() < deadline:
            if self._proc.poll() is not None:
                code = self._proc.returncode
                self._proc = None
                raise RuntimeError(f"FreeCAD exited during start (code {code}). Log tail:\n{_tail(LOG_PATH)}")
            if self._ping():
                log.info("FreeCAD up in %.1fs (pid %s)", time.monotonic() - self._started, self._proc.pid)
                return
            time.sleep(1)
        self._stop_locked()
        raise RuntimeError(
            f"FreeCAD did not answer on 127.0.0.1:{RPC_PORT} within {START_TIMEOUT}s. Log tail:\n{_tail(LOG_PATH)}"
        )

    def ensure(self) -> None:
        with self._lock:
            self.touch()
            if self.running():
                if self._ping():
                    return
                raise RuntimeError(
                    "FreeCAD is running but does not answer. It is probably busy with a long "
                    "operation or hung. Wait, then call freecad_status; if it stays hung, call "
                    "freecad_restart(discard_unsaved=true)."
                )
            self._start_locked()

    def _stop_locked(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            try:
                os.killpg(self._proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self._proc.wait(15)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self._proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self._proc.wait(5)
        self._proc = None
        self._started = None
        if self._xvfb is not None and self._xvfb.poll() is None:
            self._xvfb.terminate()
            try:
                self._xvfb.wait(5)
            except subprocess.TimeoutExpired:
                self._xvfb.kill()
        self._xvfb = None

    def stop(self) -> None:
        with self._lock:
            self._stop_locked()

    @contextmanager
    def using(self):
        """Hold FreeCAD 'in use' for one tool call: started, and never reaped mid-call."""
        with self._lock:
            self.ensure()
            self._busy += 1
        try:
            yield self.rpc()
        finally:
            with self._lock:
                self._busy -= 1
                self.touch()

    # memory -------------------------------------------------------------------
    def rss_bytes(self) -> int:
        """Summed VmRSS of FreeCAD's session (AppRun, FreeCAD, helpers)."""
        if not self.running():
            return 0
        sid = self._proc.pid  # start_new_session=True makes the child its session leader
        total_kb = 0
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            if cadpaths.parse_stat_session(_read(f"/proc/{entry}/stat")) != sid:
                continue
            total_kb += cadpaths.parse_vmrss_kb(_read(f"/proc/{entry}/status"))
        return total_kb * 1024


FC = FreeCADProcess()


# ── FreeCAD-side snippets ────────────────────────────────────────────────────
# execute_code runs these with exec(code, globals()) in the addon module, so
# every name is underscore-prefixed to avoid clobbering the addon's globals.

_DOCS_SNIPPET = r'''
import json as _json
import FreeCAD as _App
_out = []
for _n, _d in _App.listDocuments().items():
    _mod = False
    try:
        import FreeCADGui as _Gui
        _mod = bool(getattr(_Gui.getDocument(_n), "Modified", False))
    except Exception:
        pass
    _out.append({"name": _n, "label": _d.Label, "file": _d.FileName or "",
                 "modified": _mod, "objects": len(_d.Objects)})
print("OASIS_JSON:" + _json.dumps(_out))
'''


def _run_snippet(conn: Conn, code: str):
    res = conn.execute_code(code)
    if not res.get("success"):
        raise RuntimeError(res.get("error") or res.get("message") or "FreeCAD snippet failed")
    payload = cadpaths.parse_marked_json(res.get("message", ""))
    if payload is None:
        raise RuntimeError(f"FreeCAD snippet returned no result: {res.get('message', '')[-500:]}")
    return payload


def _documents(conn: Conn) -> list[dict]:
    return _run_snippet(conn, _DOCS_SNIPPET)


def _unsaved(docs: list[dict]) -> list[dict]:
    return [d for d in docs if d.get("modified") or (not d.get("file") and d.get("objects", 0) > 0)]


def _save_recovery_locked() -> list[str]:
    """Copy every unsaved document into CAD_ROOT/_recovery/<stamp>/ (saveCopy keeps the doc's own path)."""
    conn = FC.rpc(timeout=60)
    docs = _unsaved(_documents(conn))
    if not docs:
        return []
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    rdir = cadpaths.recovery_dir(CAD_ROOT, stamp)
    targets = [[d["name"], f"{rdir}/{cadpaths.part_from_doc_name(d['name'])}.FCStd"] for d in docs]
    code = (
        "import os as _os, json as _json, FreeCAD as _App\n"
        f"_os.makedirs({json.dumps(rdir)}, exist_ok=True)\n"
        "_done = []\n"
        f"for _n, _p in {json.dumps(targets)}:\n"
        "    _App.getDocument(_n).saveCopy(_p)\n"
        "    _done.append(_p)\n"
        "print('OASIS_JSON:' + _json.dumps(_done))\n"
    )
    return _run_snippet(conn, code)


# ── idle reaper ──────────────────────────────────────────────────────────────

def _reaper() -> None:
    while True:
        time.sleep(30)
        try:
            if not FC.running() or FC.busy() or FC.idle() < IDLE_SECONDS:
                continue
            with FC._lock:  # noqa: SLF001 — same module
                if not FC.running() or FC.busy() or FC.idle() < IDLE_SECONDS:
                    continue
                idle = FC.idle()
                rss = FC.rss_bytes()
                try:
                    saved = _save_recovery_locked()
                except Exception as exc:  # noqa: BLE001
                    saved = [f"recovery save failed: {exc}"]
                FC._stop_locked()  # noqa: SLF001
            log.info("idle %.0fs: stopped FreeCAD (freed ~%d MB RSS); recovery copies: %s",
                     idle, rss // 2**20, saved or "none needed")
        except Exception:  # noqa: BLE001
            log.exception("idle reaper")


# ── MCP server ───────────────────────────────────────────────────────────────

INSTRUCTIONS = f"""\
FreeCAD 1.1.1 for ButterBolt, in its own container. Rules:
1. Save every design with save_design. It writes only to
   {CAD_ROOT}/<project>/<part>.FCStd (+ exports/<part>.step), which is
   oasis-hardware/Product Design/ButterBolt on Mike's Mac. A file saved anywhere
   else is lost when the container restarts.
2. Existing designs under /reach/oasis-hardware/Product Design are read-only
   here: open_design them, then save_design a new version into your project.
3. Clean up after every task: save_design, then freecad_cleanup. FreeCAD holds
   hundreds of MB while it runs; cleanup stops it and frees all of it.
4. Check memory with freecad_status before large operations (big booleans,
   fine meshes, many open documents). Close documents you do not need.
5. Call get_view only when you need to see the model, one view at a time, at a
   small size. Other tools return text only.
6. FreeCAD starts on the first call (10-30 s) and stops by itself after
   {IDLE_SECONDS // 60} idle minutes; unsaved work is then copied to
   {CAD_ROOT}/_recovery/.
"""

mcp = FastMCP("oasis-freecad", instructions=INSTRUCTIONS)
mcp.settings.host = MCP_HOST
mcp.settings.port = MCP_PORT
try:  # DNS-rebinding protection: only the in-network host names may call us.
    from mcp.server.transport_security import TransportSecuritySettings

    mcp.settings.transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True, allowed_hosts=ALLOWED_HOSTS, allowed_origins=[],
    )
except ImportError:  # older SDK — the network (internal, two members) is the control
    log.warning("mcp SDK has no TransportSecuritySettings; Host-header check is off")


def _text(value) -> list[TextContent]:
    body = value if isinstance(value, str) else json.dumps(value, indent=2)
    return [TextContent(type="text", text=body)]


def _error(exc: Exception) -> list[TextContent]:
    return _text({"ok": False, "error": str(exc)})


# Upstream tools, re-registered: same names, schemas and docstrings, but every
# call goes through FC.using() (lazy start, idle clock, no reaping mid-call).
upstream._only_text_feedback = True  # noqa: SLF001
upstream.get_freecad_connection = lambda: FC.rpc()


def _managed(fn):
    @functools.wraps(fn)
    def inner(*args, **kwargs):
        try:
            with FC.using():
                return fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 — surface start failures as tool text
            return _error(exc)
    return inner


for _fn in (upstream.create_document, upstream.create_object, upstream.edit_object,
            upstream.delete_object, upstream.get_objects, upstream.get_object,
            upstream.list_documents):
    mcp.add_tool(_managed(_fn))
# NOT registered: insert_part_from_library / get_parts_list (the parts-library
# addon is not installed here) and upstream execute_code / get_view (replaced below).


@mcp.tool()
def execute_code(code: str) -> list[TextContent]:
    """Run Python inside FreeCAD (FreeCAD, FreeCADGui, Part, PartDesign, Sketcher, Import, Mesh are available).

    Use print() to return values; the printed output comes back as text.
    No screenshot is taken; call get_view when you need to see the model.
    Save work with save_design, not doc.saveAs(): only the save_design folder
    reaches Mike's Mac.
    """
    try:
        with FC.using() as conn:
            res = conn.execute_code(code)
        if res.get("success"):
            return _text(f"Code executed successfully: {res.get('message', '')}")
        return _text(f"Failed to execute code: {res.get('error', res)}")
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


@mcp.tool()
def get_view(
    view_name: Literal["Isometric", "Front", "Top", "Right", "Back", "Left", "Bottom", "Dimetric", "Trimetric"] = "Isometric",
    width: int = 800,
    height: int = 600,
    focus_object: str | None = None,
) -> list[ImageContent | TextContent]:
    """Return ONE screenshot of the active 3D view.

    Each image stays in your context, so ask for one view at a time and keep
    the size small (default 800x600; the maximum side is capped).
    """
    width = max(64, min(int(width), VIEW_MAX_PX))
    height = max(64, min(int(height), VIEW_MAX_PX))
    try:
        with FC.using() as conn:
            shot = conn.screenshot(view_name, width, height, focus_object)
        if shot:
            return [ImageContent(type="image", data=shot, mimeType="image/png")]
        return _text("No screenshot: the active view is not a 3D view (TechDraw, Spreadsheet) or no document is open.")
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


@mcp.tool()
def open_design(path: str) -> list[TextContent]:
    """Open an existing .FCStd (or import a .step/.stp) from oasis-hardware.

    path must be absolute and under /reach/oasis-hardware/Product Design or
    /reach/oasis-hardware/cadgen. Those files are read-only here: to change
    one, open it, edit, then save_design a new version into your project.
    """
    try:
        target = cadpaths.check_readable(path, READ_ROOTS)
        if not os.path.isfile(target):
            raise cadpaths.LayoutError(f"no such file: {target}")
        if target.lower().endswith(".fcstd"):
            code = (
                "import json as _json, FreeCAD as _App\n"
                f"_d = _App.openDocument({json.dumps(target)})\n"
                "print('OASIS_JSON:' + _json.dumps({'document': _d.Name, 'objects': len(_d.Objects)}))\n"
            )
        else:
            name = cadpaths.part_from_doc_name(os.path.splitext(os.path.basename(target))[0])
            code = (
                "import json as _json, FreeCAD as _App, Import as _Import\n"
                f"_d = _App.newDocument({json.dumps(name)})\n"
                f"_Import.insert({json.dumps(target)}, _d.Name)\n"
                "_d.recompute()\n"
                "print('OASIS_JSON:' + _json.dumps({'document': _d.Name, 'objects': len(_d.Objects)}))\n"
            )
        with FC.using() as conn:
            return _text({"ok": True, **_run_snippet(conn, code)})
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


@mcp.tool()
def save_design(
    doc_name: str,
    project: str,
    part: str | None = None,
    exports: list[Literal["step", "stl"]] | None = None,
    overwrite: bool = False,
) -> list[TextContent]:
    """Save a document into oasis-hardware so Mike can open it on the Mac.

    Writes Product Design/ButterBolt/<project>/<part>.FCStd and, per `exports`
    (default ["step"]), exports/<part>.step and/or exports/<part>.stl.
    project: lowercase slug, e.g. "scd41-enclosure". part: e.g. "lid_v2"
    (default: the document name). Keep versions as new part names (_v1, _v2)
    rather than overwriting; overwrite=true is refused unless the target is
    this same document's own file. Also keep <project>/README.md current:
    what the part is, the spec it came from, and its status.
    """
    try:
        kinds = cadpaths.check_exports(["step"] if exports is None else exports)
        paths = cadpaths.design_paths(CAD_ROOT, project, part or cadpaths.part_from_doc_name(doc_name))
        with FC.using() as conn:
            docs = {d["name"]: d for d in _documents(conn)}
            if doc_name not in docs:
                raise cadpaths.LayoutError(f"no open document {doc_name!r}; open ones: {sorted(docs)}")
            own_file = os.path.normpath(docs[doc_name]["file"] or "") == os.path.normpath(paths["fcstd"])
            if os.path.exists(paths["fcstd"]) and not own_file and not overwrite:
                raise cadpaths.LayoutError(
                    f"{paths['fcstd']} already exists and belongs to another save. Use a new part "
                    "name (for example add _v2), or pass overwrite=true if replacing it is intended."
                )
            export_pairs = [[k, paths[k]] for k in kinds]
            code = (
                "import os as _os, json as _json, FreeCAD as _App\n"
                f"_d = _App.getDocument({json.dumps(doc_name)})\n"
                f"_os.makedirs({json.dumps(paths['project_dir'])}, exist_ok=True)\n"
                "_d.recompute()\n"
                f"_d.saveAs({json.dumps(paths['fcstd'])})\n"
                "_res = {'fcstd': _d.FileName, 'exports': {}}\n"
                "_objs = [o for o in _d.Objects if hasattr(o, 'Shape') and not o.Shape.isNull()"
                " and getattr(o, 'Visibility', True)]\n"
                "_roots = [o for o in _objs if not any(hasattr(p, 'Shape') for p in o.InList)] or _objs\n"
                "_solids = [o for o in _roots if o.Shape.Solids]\n"
                f"for _k, _p in {json.dumps(export_pairs)}:\n"
                "    _sel = _solids if _k == 'stl' else (_solids or _roots)\n"
                "    if not _sel:\n"
                "        _res['exports'][_k] = 'skipped: no visible solid'\n"
                "        continue\n"
                "    _os.makedirs(_os.path.dirname(_p), exist_ok=True)\n"
                "    if _k == 'step':\n"
                "        import Import as _Import\n"
                "        _Import.export(_sel, _p)\n"
                "    else:\n"
                "        import Mesh as _Mesh\n"
                "        _Mesh.export(_sel, _p)\n"
                "    _res['exports'][_k] = _p\n"
                "_res['shapes'] = [o.Name for o in (_solids or _roots)]\n"
                "print('OASIS_JSON:' + _json.dumps(_res))\n"
            )
            result = _run_snippet(conn, code)
        mac = {k: cadpaths.host_path(v, CAD_ROOT, HOST_ROOT)
               for k, v in [("fcstd", result.get("fcstd", ""))] + list(result.get("exports", {}).items())
               if isinstance(v, str) and v.startswith("/")}
        return _text({"ok": True, **result, "mac_paths": mac,
                      "next": "update <project>/README.md; when the task is done call freecad_cleanup"})
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


@mcp.tool()
def list_designs(project: str | None = None) -> list[TextContent]:
    """List your saved projects, or the files of one project, under Product Design/ButterBolt. Does not start FreeCAD."""
    FC.touch()
    try:
        if project is None:
            names = sorted(n for n in os.listdir(CAD_ROOT)
                           if os.path.isdir(os.path.join(CAD_ROOT, n)) and not n.startswith((".", "_")))
            return _text({"cad_root": CAD_ROOT, "projects": names})
        pdir = cadpaths.design_paths(CAD_ROOT, project, "x")["project_dir"]
        files = []
        for base, _dirs, fnames in os.walk(pdir):
            for f in sorted(fnames):
                full = os.path.join(base, f)
                files.append({"path": full, "bytes": os.path.getsize(full)})
        return _text({"project": project, "files": files})
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


def _status(include_docs: bool = True) -> dict:
    used = cadpaths.parse_cgroup_bytes(_read("/sys/fs/cgroup/memory.current"))
    limit = cadpaths.parse_cgroup_bytes(_read("/sys/fs/cgroup/memory.max"))
    status = {
        "freecad_running": FC.running(),
        "uptime_s": None if FC.uptime() is None else round(FC.uptime()),
        "idle_s": round(FC.idle()),
        "idle_stop_after_s": IDLE_SECONDS,
        "freecad_rss_mb": FC.rss_bytes() // 2**20,
        "container_memory_mb": None if used is None else used // 2**20,
        "container_limit_mb": None if limit is None else limit // 2**20,
        "memory_pressure": cadpaths.memory_pressure(used, limit),
    }
    if include_docs and FC.running():
        try:
            status["documents"] = _documents(FC.rpc(timeout=15))
        except Exception as exc:  # noqa: BLE001
            status["documents_error"] = str(exc)
    if status["memory_pressure"]:
        status["advice"] = "Container memory is above 80% of its limit: save_design, then freecad_cleanup or close documents."
    return status


@mcp.tool()
def freecad_status() -> list[TextContent]:
    """Report whether FreeCAD runs, its memory, the container memory limit, and the open documents. Does not start FreeCAD."""
    FC.touch()
    return _text(_status())


@mcp.tool()
def freecad_start() -> list[TextContent]:
    """Start FreeCAD now (other tools also start it on demand). Returns the status."""
    try:
        with FC.using():
            pass
        return _text(_status())
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


@mcp.tool()
def freecad_cleanup(discard_unsaved: bool = False) -> list[TextContent]:
    """Close all documents and stop FreeCAD, freeing all of its memory. Call this at the end of every CAD task.

    Refuses while a document has unsaved changes, and names them: save_design
    them first, or pass discard_unsaved=true to drop the changes on purpose.
    """
    FC.touch()
    try:
        with FC._lock:  # noqa: SLF001
            if not FC.running():
                return _text({"ok": True, "message": "FreeCAD was not running; nothing to clean."})
            if FC.busy():
                raise RuntimeError("another FreeCAD call is still running; try again when it finishes")
            docs = _documents(FC.rpc(timeout=30))
            unsaved = _unsaved(docs)
            if unsaved and not discard_unsaved:
                return _text({"ok": False, "error": "unsaved documents", "unsaved": unsaved,
                              "fix": "save_design each one, or call freecad_cleanup(discard_unsaved=true)"})
            rss = FC.rss_bytes()
            FC._stop_locked()  # noqa: SLF001
        return _text({"ok": True, "closed": [d["name"] for d in docs],
                      "discarded": [d["name"] for d in unsaved] if discard_unsaved else [],
                      "freed_rss_mb": rss // 2**20})
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


@mcp.tool()
def freecad_restart(discard_unsaved: bool = False) -> list[TextContent]:
    """Stop and start FreeCAD. Use it when FreeCAD hangs or memory stays high after closing documents.

    Refuses while documents have unsaved changes unless discard_unsaved=true.
    A hung FreeCAD cannot report its documents; then pass discard_unsaved=true.
    """
    FC.touch()
    try:
        with FC._lock:  # noqa: SLF001
            if FC.running() and not discard_unsaved:
                unsaved = _unsaved(_documents(FC.rpc(timeout=15)))
                if unsaved:
                    return _text({"ok": False, "error": "unsaved documents", "unsaved": unsaved})
            FC._stop_locked()  # noqa: SLF001
            FC.ensure()
        return _text(_status())
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


try:
    from starlette.requests import Request
    from starlette.responses import JSONResponse

    @mcp.custom_route("/healthz", methods=["GET"])
    async def healthz(_request: Request) -> JSONResponse:
        return JSONResponse({"ok": True, "freecad_running": FC.running()})
except (ImportError, AttributeError):
    log.warning("no custom_route support; /healthz is off")


def main() -> None:
    os.makedirs(CAD_ROOT, exist_ok=True)
    threading.Thread(target=_reaper, name="idle-reaper", daemon=True).start()
    log.info("oasis-freecad MCP on %s:%s/mcp; CAD root %s; idle stop %ss",
             MCP_HOST, MCP_PORT, CAD_ROOT, IDLE_SECONDS)
    mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
