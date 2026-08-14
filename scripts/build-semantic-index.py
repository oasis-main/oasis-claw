#!/usr/bin/env python3
"""Host-side builder for the per-bot semantic search index (CLAW-094).

Walks a corpus ONCE, embeds each distinct chunk ONCE (content-hash cache),
then writes one (vectors, metadata, manifest) triplet PER AUTHORIZED BOT,
delivered via a Docker bind mount into that bot's own container — never a
shared, network-queryable store. Authorization is computed from
scripts/lib/semantic_index_authz.py, which reads the SAME
compile-role.py --emit-reach-compose output Docker itself mounts from, so this
script's idea of "who may see this file" cannot drift from what is actually
mounted.

Run on the HOST, in the same trusted context scripts/compile-role.py already
requires — never inside a sandboxed bot container. Reads bots/<bot>/role.yaml
(via the authz module), the real corpus filesystem, and calls the
oasis-semantics sidecar over its loopback-published port (127.0.0.1:8732 —
"oasis-semantics:8732" is a Docker-internal DNS name and does not resolve from
here).

Usage:
    python3 scripts/build-semantic-index.py --corpus exp
    python3 scripts/build-semantic-index.py --corpus exp --bot house   # targeted rebuild

Design doc: CLAW-094 final design (round 3), sections 1, 2, 4, 5, 7.
"""

from __future__ import annotations

import argparse
import errno
import json
import multiprocessing
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts" / "lib"))
import semantic_index_authz as authz  # noqa: E402

# ── Locations (design section 3 / header decisions 1 and 6) ──────────────────
# Deliberately OUTSIDE /Users/Michaellee/Documents/Runes: that whole tree sits
# inside Yes Man's broad /reach/runes mount, so anything placed under it would
# be readable by Yes Man's own deep_search tool regardless of which bot the
# content was actually built for — the exact defeat this redesign exists to
# prevent. New top-level sibling of Runes/Knowledge/Nimbus/HelloWorld.
INDEX_ROOT = Path("/Users/Michaellee/Documents/.oasis-semantic-index")
CACHE_DB = INDEX_ROOT / ".cache" / "embed-cache.sqlite3"
LOG_FILE = INDEX_ROOT / ".logs" / "build-semantic-index.log"

DENY_LISTS_PATH = REPO_ROOT / "extensions" / "oasis-find" / "src" / "deny-lists.json"

# Registry of known corpora. Extend when a second corpus (e.g. oasis-x) ships.
CORPORA: dict[str, str] = {
    "exp": "/Users/Michaellee/Documents/Runes/exp",
}
# Corpus roots that fall under this path require the nested-shield self-test
# to run first (section 1) — the current "exp" corpus never overlaps it, but
# the guard is unconditional on corpus root, not on which corpus is "current",
# so a future oasis-x build cannot silently skip the check by omission.
OASIS_X_ROOT = os.path.realpath("/Users/Michaellee/Documents/Runes/oasis-x")

EMBED_URL = "http://127.0.0.1:8732/api/embed"
EMBED_MODEL = "default"
EMBED_BATCH_SIZE = 64
EMBED_TIMEOUT_S = 60

# Matches deep-search.ts's MAX_CHUNK_CHARS (1200) — bge-reranker-base truncates
# the concatenated query+passage at 512 tokens; staying at the SAME budget
# keeps build-time chunks and query-time lexical passages consistently sized.
CHUNK_MAX_CHARS = 1200
CHUNK_OVERLAP_LINES = 10

MAX_FILE_BYTES = 2_000_000  # matches DEFAULT_SEARCH_LIMITS.maxFileBytes in search.ts

# Extension allowlist -- SEMANTIC-INDEX-SPECIFIC, deliberately NOT part of the
# shared deny-lists.json fs_grep/fs_glob/deep_search's lexical stage also use.
#
# Discovered running this builder against the real /reach/exp corpus for the
# first time: with only the shared deny-dir/deny-glob filters applied, the
# walk found 174,256 files, dominated by 123,104 .json files (this project's
# OWN generated market-data caches, e.g. prediction_market_trading/) and (once
# the exp_venv deny-dir gap above was fixed) still thousands of .parquet/.gz/
# .dat/.png/.so/.mat files -- none of it source code or documentation.
#
# The asymmetry that makes an allowlist correct HERE but wrong for fs_grep:
# fs_grep reads a candidate file only if it happens to match the caller's own
# query, so an unhelpful file costs nothing extra. This builder EMBEDS AND
# PERSISTS every accepted file's content, unconditionally, whether or not any
# future query will ever want it -- so an over-broad walk here has a real,
# compounding cost (build time, on-disk storage, and diluting every future
# query's candidate pool with financial-data noise a model trained on
# natural-language question/passage pairs was never going to rank usefully).
# Denying by name (as the shared list does for vendored/noise DIRECTORIES)
# does not fix this: prediction_market_trading/ is this project's own real
# directory, not vendored or excludable by name -- only its CONTENT TYPE
# distinguishes signal (source, docs) from noise (data caches).
SEMANTIC_INDEX_ALLOWED_EXTENSIONS = {
    ".py", ".pyi", ".md", ".mdx", ".rst", ".txt",
    ".yaml", ".yml", ".toml", ".cfg", ".ini",
    ".sh", ".sql", ".tf",
    ".ts", ".tsx", ".js", ".jsx",
}

# ── Secret-content scan (CLAW-096) — DEFENSE IN DEPTH, not the primary control.
#
# The primary control is filter_gitignored() below: a corpus's own hierarchical
# .gitignore chain is the strongest available signal for "the author already
# decided this must never be distributed" (nested files, negation patterns,
# and independent nested-repo boundaries all included -- see that function).
#
# This scan exists because .gitignore coverage is not guaranteed complete: a
# secret can land in a file the author never thought to exclude (a new
# my_secrets.py-style module before .gitignore is updated, a stray literal in
# an otherwise-ordinary .py file). Treat this as a real, not hypothetical,
# risk for any bot whose corpus can reach a file the author didn't
# anticipate — gitignore filtering alone only catches a secret file that is
# actually named in a .gitignore; this scan is the layer that still catches
# the next one even if nobody updates a .gitignore first.
#
# A match SKIPS THE WHOLE FILE (never a partial redaction -- a secret can
# straddle a chunk boundary, and a regex miss on one line of a "mostly safe"
# file is not an acceptable failure mode for a persistent index). The matched
# RULE NAME is logged, never the matched text itself (same rule as _log's
# module-level policy: basenames and reasons only).
SECRET_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("aws_access_key_id", re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("private_key_block", re.compile(r"-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    # Broad, deliberately over-inclusive net: an identifier ENDING in one of
    # these suffixes, assigned a quoted literal of 12+ chars. Catches
    # tradier_token, gemini_api_key, kalshi_key_id, bedrock_aws_secret_access_key,
    # OASIS_WEATHER_API_KEY, etc. False positives (a non-secret config value
    # that happens to end in _key) fail SAFE here -- an over-excluded file
    # costs relevance, not exposure -- and are visible in the build log by rule
    # name for tuning.
    (
        "generic_secret_assignment",
        re.compile(
            r"(?i)\b[A-Za-z_][A-Za-z0-9_]*(_key|_token|_secret|key_id|_password|_passwd|_credential)"
            r"\s*[:=]\s*[\"'][^\"'\s]{12,}[\"']"
        ),
    ),
]


def find_secret_pattern(text: str) -> str | None:
    for name, pattern in SECRET_PATTERNS:
        if pattern.search(text):
            return name
    return None


# ── Hierarchical .gitignore filtering (CLAW-096) — PRIMARY control ───────────
# Delegates entirely to `git check-ignore`, run against the git repo enclosing
# the corpus root, rather than reimplementing gitignore's precedence rules
# (nested .gitignore files, later-pattern-wins, `!negation`, directory-only
# `trailing/`). git already gets this right; a hand-rolled matcher is a novel
# source of exactly the kind of bug this feature exists to prevent.
def find_git_toplevel(path: str) -> str | None:
    try:
        proc = subprocess.run(
            ["git", "-C", path, "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip()


def compute_gitignored_set(git_toplevel: str, real_paths: list[str]) -> set[str]:
    """Returns the subset of real_paths `git check-ignore` reports as ignored.
    Batches via --stdin -z (NUL-separated both directions -- safe for any
    filename) to avoid one subprocess per file. Raises on a git failure
    (rc not in {0, 1}) rather than silently treating a broken git invocation
    as "nothing is ignored" -- a fail-open here would defeat the entire
    control."""
    if not real_paths:
        return set()
    ignored: set[str] = set()
    batch_size = 1000
    for i in range(0, len(real_paths), batch_size):
        batch = real_paths[i : i + batch_size]
        stdin_data = "\0".join(batch) + "\0"
        proc = subprocess.run(
            ["git", "-C", git_toplevel, "check-ignore", "--stdin", "-z"],
            input=stdin_data, capture_output=True, text=True, timeout=60,
        )
        if proc.returncode not in (0, 1):
            raise RuntimeError(
                f"git check-ignore failed rc={proc.returncode} stderr={proc.stderr[:300]!r} "
                "-- refusing to build without a working gitignore signal"
            )
        if proc.stdout:
            ignored.update(p for p in proc.stdout.split("\0") if p)
    return ignored


def filter_gitignored(corpus_root: str, files: list[ScannedFile]) -> tuple[list[ScannedFile], int]:
    """Drops any file git reports as ignored by corpus_root's own hierarchical
    .gitignore chain. If corpus_root is not inside a git work tree, filtering
    is DISABLED and loudly logged -- never a silent no-op, since silence here
    would look identical to "nothing was ignored"."""
    toplevel = find_git_toplevel(corpus_root)
    if toplevel is None:
        _log("warn", f"corpus root {os.path.basename(corpus_root)!r} is not inside a git work tree -- gitignore filtering DISABLED for this build")
        return files, 0
    ignored = compute_gitignored_set(toplevel, [f.real_path for f in files])
    if not ignored:
        return files, 0
    kept = [f for f in files if f.real_path not in ignored]
    return kept, len(files) - len(kept)


BUILD_ID_BYTES = 36  # a UUID4 string, ASCII-encoded, fixed width


# ── Logging (header decision 6): basenames and reasons only, NEVER a full ───
# host path or chunk text. A future misconfiguration that widens some bot's
# reach to cover this log directory must not turn a log line into a leak.
def _log(severity: str, message: str) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    ts = datetime.now(timezone.utc).isoformat()
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"{ts} {severity} {message}\n")


# ── Deny lists (design section 4) — single source, same file search.ts reads ─
def _glob_to_regex(glob: str) -> re.Pattern:
    """Identical mapping to search.ts's globToRegExp: * -> [^/]*, ? -> [^/],
    everything else escaped, case-insensitive, fully anchored."""
    out = []
    for ch in glob:
        if ch == "*":
            out.append("[^/]*")
        elif ch == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(ch))
    return re.compile("^" + "".join(out) + "$", re.IGNORECASE)


def load_deny_lists() -> tuple[list[re.Pattern], set[str]]:
    data = json.loads(DENY_LISTS_PATH.read_text())
    glob_patterns = [_glob_to_regex(g) for g in data["denyGlobs"]]
    deny_dirs = set(data["denyDirs"])
    return glob_patterns, deny_dirs


def is_denied_name(basename: str, glob_patterns: list[re.Pattern]) -> bool:
    return any(p.match(basename) for p in glob_patterns)


# ── TOCTOU-safe open (design section 2, finding 3) ────────────────────────────
def safe_open_for_read(path: str) -> int | None:
    """Open path for reading only if it is still the same regular file it was
    at lstat time, and only if it is not a symlink at all. Returns an open fd,
    or None if the file must be skipped. See this module's docstring and the
    design doc section 2 for the exact attack this closes: a write-capable bot
    racing a delete-and-symlink swap between the corpus walk's scan-time
    symlink check and this open, aimed at making this MORE-PRIVILEGED
    host-side process read content the bot's own container cannot reach."""
    try:
        pre_lstat = os.lstat(path)  # taken immediately before open()
    except OSError:
        return None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as e:
        if e.errno == errno.ELOOP:
            return None  # path is a symlink now -> skip, never follow
        return None
    post_fstat = os.fstat(fd)
    if (post_fstat.st_dev, post_fstat.st_ino) != (pre_lstat.st_dev, pre_lstat.st_ino):
        os.close(fd)
        return None  # swapped for a different file between lstat and open -> skip, never trust
    return fd


# ── Chunking ───────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Chunk:
    text: str
    line_start: int  # 1-based, inclusive
    line_end: int  # 1-based, inclusive


def chunk_text(lines: list[str], max_chars: int = CHUNK_MAX_CHARS, overlap_lines: int = CHUNK_OVERLAP_LINES) -> list[Chunk]:
    """Consecutive lines until ~max_chars accumulates, then a new chunk starts
    with the last `overlap_lines` carried forward, so a match near a chunk
    boundary is not split away from its context."""
    if not lines:
        return []
    chunks: list[Chunk] = []
    start_idx = 0  # 0-based index into `lines`
    i = 0
    cur_chars = 0
    while i < len(lines):
        cur_chars += len(lines[i]) + 1
        if cur_chars >= max_chars or i == len(lines) - 1:
            text = "\n".join(lines[start_idx : i + 1])
            chunks.append(Chunk(text=text, line_start=start_idx + 1, line_end=i + 1))
            next_start = max(start_idx + 1, i + 1 - overlap_lines)
            if i == len(lines) - 1:
                break
            start_idx = next_start
            i = start_idx
            cur_chars = 0
            continue
        i += 1
    return chunks


# ── Corpus walk (design section 2) ────────────────────────────────────────
@dataclass(frozen=True)
class ScannedFile:
    real_path: str  # os.path.realpath()-resolved
    mtime_ns: int


def walk_corpus(root: str, glob_patterns: list[re.Pattern], deny_dirs: set[str]) -> list[ScannedFile]:
    real_root = os.path.realpath(root)
    found: list[ScannedFile] = []
    stack = [real_root]
    while stack:
        d = stack.pop()
        try:
            entries = list(os.scandir(d))
        except OSError:
            continue
        for entry in entries:
            # follow_symlinks=False: a symlinked directory is never descended
            # into, a symlinked file is never opened at SCAN time. This alone
            # is not sufficient — see safe_open_for_read, called later, for
            # the check-to-open race this cannot close on its own.
            if entry.is_dir(follow_symlinks=False):
                if entry.name in deny_dirs:
                    continue
                stack.append(entry.path)
                continue
            if not entry.is_file(follow_symlinks=False):
                continue
            if is_denied_name(entry.name, glob_patterns):
                _log("info", f"skip deny_glob basename={entry.name!r}")
                continue
            ext = os.path.splitext(entry.name)[1].lower()
            if ext not in SEMANTIC_INDEX_ALLOWED_EXTENSIONS:
                continue  # not deny-listed, just not a content type this index embeds -- see the allowlist's own comment
            try:
                st = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if st.st_size > MAX_FILE_BYTES:
                _log("info", f"skip oversize basename={entry.name!r}")
                continue
            found.append(ScannedFile(real_path=entry.path, mtime_ns=st.st_mtime_ns))
    return found


def looks_binary(buf: bytes) -> bool:
    return b"\x00" in buf[:8192]


# ── Embed-cache (design section 2) ────────────────────────────────────────
def open_cache_db() -> sqlite3.Connection:
    CACHE_DB.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    con = sqlite3.connect(str(CACHE_DB))
    con.execute("PRAGMA journal_mode=WAL")
    con.execute(
        """CREATE TABLE IF NOT EXISTS chunks (
             content_sha256 TEXT NOT NULL,
             model          TEXT NOT NULL,
             dim            INTEGER NOT NULL,
             vector         BLOB NOT NULL,
             text           TEXT NOT NULL,
             PRIMARY KEY (content_sha256, model)
           )"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS chunk_sources (
             content_sha256   TEXT NOT NULL,
             source_host_path TEXT NOT NULL,
             source_mtime_ns  INTEGER NOT NULL,
             line_start       INTEGER NOT NULL,
             line_end         INTEGER NOT NULL,
             corpus_id        TEXT NOT NULL,
             PRIMARY KEY (content_sha256, source_host_path)
           )"""
    )
    con.execute("CREATE INDEX IF NOT EXISTS idx_chunk_sources_hash ON chunk_sources(content_sha256)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_chunk_sources_corpus ON chunk_sources(corpus_id)")
    con.commit()
    return con


def purge_stale_chunk_sources(con: sqlite3.Connection, corpus_id: str) -> int:
    """DELETE every chunk_sources row previously recorded for corpus_id,
    before the current walk repopulates it fresh.

    chunk_sources answers "which files CURRENTLY contain this content" -- it
    is not a permanent history. Without this purge, a file that stops
    appearing in the walk (deleted, newly matched by .gitignore, newly
    matched by a secret pattern, or a deny-list update) stays in every future
    per-bot output forever, because distribute_for_bot() reads this table's
    full contents unconditionally.

    Discovered LIVE (CLAW-096): adding filter_gitignored() and
    find_secret_pattern() alone is not enough. Those filters correctly stop a
    newly-excluded file from being RE-inserted on the next build, but nothing
    deletes the rows an earlier build already inserted, so
    distribute_for_bot() keeps reading and redistributing them regardless.
    This is a REGRESSION-tested finding, not a hypothetical: see
    assert_purge_stale_chunk_sources_removes_previously_recorded_rows in
    scripts/tests/test_build_semantic_index.py.

    The content-addressed `chunks` table (hash -> vector/text) is left
    untouched -- it carries no path information and is a pure embedding-cost
    cache, safe to keep forever."""
    cur = con.execute("DELETE FROM chunk_sources WHERE corpus_id = ?", (corpus_id,))
    con.commit()
    return cur.rowcount


def embed_batch(texts: list[str]) -> tuple[list[list[float]], str, int]:
    """Returns (vectors, model, dim). Raises on failure — a build with a
    reachability problem to the sidecar should fail loudly, not silently
    produce an empty or partial index."""
    body = json.dumps({"model": EMBED_MODEL, "input": texts}).encode("utf-8")
    req = urllib.request.Request(EMBED_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=EMBED_TIMEOUT_S) as resp:
        data = json.loads(resp.read())
    vectors = data["embeddings"]
    dim = len(vectors[0]) if vectors else 0
    return vectors, data.get("model", EMBED_MODEL), dim


def l2_normalize(vec: list[float]) -> list[float]:
    norm = sum(x * x for x in vec) ** 0.5
    if norm == 0:
        return vec
    return [x / norm for x in vec]


import hashlib  # noqa: E402


def embed_and_cache_corpus(con: sqlite3.Connection, files: list[ScannedFile], corpus_id: str) -> tuple[str, int]:
    """Walk `files`, chunk each, record every (content_hash, path) occurrence
    in chunk_sources unconditionally, and embed a chunk's content only if no
    (content_hash, model) row exists yet in `chunks`. Returns (model, dim).

    Purges corpus_id's prior chunk_sources rows FIRST -- see
    purge_stale_chunk_sources' own docstring for why this is required for
    correctness, not just hygiene."""
    n_purged = purge_stale_chunk_sources(con, corpus_id)
    if n_purged:
        _log("info", f"purged {n_purged} stale chunk_sources row(s) for corpus={corpus_id!r} before repopulating")
    model = EMBED_MODEL
    dim = 0
    pending_texts: list[str] = []
    pending_hashes: list[str] = []

    def flush() -> None:
        nonlocal dim, model
        if not pending_texts:
            return
        vectors, resolved_model, resolved_dim = embed_batch(pending_texts)
        model, dim = resolved_model, resolved_dim
        for h, text, vec in zip(pending_hashes, pending_texts, vectors):
            normed = l2_normalize(vec)
            con.execute(
                "INSERT OR IGNORE INTO chunks (content_sha256, model, dim, vector, text) VALUES (?, ?, ?, ?, ?)",
                (h, model, dim, _vector_to_blob(normed), text),
            )
        con.commit()
        pending_texts.clear()
        pending_hashes.clear()

    scanned = 0
    embedded = 0
    for f in files:
        fd = safe_open_for_read(f.real_path)
        if fd is None:
            _log("warn", f"skip symlink_race basename={os.path.basename(f.real_path)!r}")
            continue
        try:
            buf = os.read(fd, MAX_FILE_BYTES + 1)
        finally:
            os.close(fd)
        if looks_binary(buf):
            continue
        text = buf.decode("utf-8", errors="ignore")
        secret_rule = find_secret_pattern(text)
        if secret_rule is not None:
            _log("warn", f"skip secret_pattern={secret_rule} basename={os.path.basename(f.real_path)!r}")
            continue
        scanned += 1
        lines = text.split("\n")
        for chunk in chunk_text(lines):
            h = hashlib.sha256(chunk.text.encode("utf-8")).hexdigest()
            con.execute(
                "INSERT OR IGNORE INTO chunk_sources "
                "(content_sha256, source_host_path, source_mtime_ns, line_start, line_end, corpus_id) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (h, f.real_path, f.mtime_ns, chunk.line_start, chunk.line_end, corpus_id),
            )
            existing = con.execute(
                "SELECT 1 FROM chunks WHERE content_sha256 = ? AND model = ? LIMIT 1", (h, EMBED_MODEL)
            ).fetchone()
            if existing is None and h not in pending_hashes:
                pending_hashes.append(h)
                pending_texts.append(chunk.text)
                embedded += 1
                if len(pending_texts) >= EMBED_BATCH_SIZE:
                    flush()
    flush()
    con.commit()
    _log("info", f"walk complete files_scanned={scanned} chunks_embedded={embedded}")
    return model, dim


def _vector_to_blob(vec: list[float]) -> bytes:
    import struct

    return struct.pack(f"<{len(vec)}f", *vec)


# ── Distribute (design section 2) — one isolated process per bot ─────────────
def distribute_for_bot(args: tuple[str, str, str]) -> tuple[str, int]:
    """Pure, stateless per-bot invocation: its only inputs are the bot id, the
    cache DB path, and the corpus id. Run as a SEPARATE OS PROCESS (via
    multiprocessing.Pool, never a thread pool or a shared-loop accumulator) so
    a coding error in one bot's pass is structurally unable to leak into
    another bot's output through shared process state. Returns
    (bot, row_count); writes nothing if row_count is 0 (matches
    extensions/oasis-find/index.ts's own rule: zero authorized roots -> no
    tool/file at all, not an empty one)."""
    bot, cache_db_path, corpus_id = args
    triples = authz.get_bot_triples(bot)  # FRESH per-process, never inherited
    con = sqlite3.connect(f"file:{cache_db_path}?mode=ro", uri=True)
    rows = con.execute(
        "SELECT cs.content_sha256, cs.source_host_path, cs.source_mtime_ns, "
        "cs.line_start, cs.line_end, c.model, c.dim, c.vector, c.text "
        "FROM chunk_sources cs JOIN chunks c ON c.content_sha256 = cs.content_sha256 "
        "WHERE cs.corpus_id = ?",
        (corpus_id,),
    ).fetchall()

    entries = []
    vectors: list[bytes] = []
    model = EMBED_MODEL
    dim = 0
    for content_hash, host_path, mtime_ns, line_start, line_end, row_model, row_dim, vector_blob, text in rows:
        real_p = os.path.realpath(host_path)
        authorized, admitting = authz.resolve_authorization(triples, real_p)
        if not authorized or admitting is None:
            continue
        container_path = authz.to_bot_container_path(admitting, real_p)
        model, dim = row_model, row_dim
        entries.append(
            {
                "path": container_path,
                "line_start": line_start,
                "line_end": line_end,
                "text": text,
                "content_sha256": content_hash,
                "source_mtime_ns": mtime_ns,
            }
        )
        vectors.append(vector_blob)
    con.close()

    if not entries:
        return bot, 0

    _write_bot_triplet(bot, corpus_id, entries, vectors, model, dim)
    return bot, len(entries)


def _write_bot_triplet(
    bot: str, corpus_id: str, entries: list[dict], vectors: list[bytes], model: str, dim: int
) -> None:
    """Atomic write: temp files, then rename in a FIXED order — vectors, then
    metadata, then manifest LAST — so a reader can never observe a half-written
    triplet, and so that by the time a new build_id becomes visible in
    manifest.json, the vectors and metadata files behind it are already fully
    in place (design section 5's getCurrentIndex depends on this ordering)."""
    out_dir = INDEX_ROOT / bot
    out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)

    build_id = str(uuid.uuid4())
    assert len(build_id.encode("ascii")) == BUILD_ID_BYTES

    vectors_path = out_dir / f"{corpus_id}.vectors.f32"
    meta_path = out_dir / f"{corpus_id}.meta.jsonl"
    manifest_path = out_dir / f"{corpus_id}.manifest.json"

    vectors_tmp = vectors_path.with_suffix(vectors_path.suffix + ".tmp")
    meta_tmp = meta_path.with_suffix(meta_path.suffix + ".tmp")
    manifest_tmp = manifest_path.with_suffix(manifest_path.suffix + ".tmp")

    with open(vectors_tmp, "wb") as f:
        for v in vectors:
            f.write(v)
        f.write(build_id.encode("ascii"))

    authorized_roots = sorted({t.host_root for t in authz.get_bot_triples(bot)})
    with open(meta_tmp, "w", encoding="utf-8") as f:
        for e in entries:
            line = dict(e)
            line["build_id"] = build_id
            f.write(json.dumps(line, ensure_ascii=False) + "\n")

    manifest = {
        "bot": bot,
        "corpus": corpus_id,
        "model": model,
        "dim": dim,
        "count": len(entries),
        "normalized": True,
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "build_id": build_id,
        "authorized_roots": authorized_roots,
    }
    with open(manifest_tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f)

    os.rename(vectors_tmp, vectors_path)
    os.rename(meta_tmp, meta_path)
    os.rename(manifest_tmp, manifest_path)  # manifest LAST
    _log("info", f"wrote bot={bot} corpus={corpus_id} count={len(entries)} build_id={build_id}")


# ── Entry point ────────────────────────────────────────────────────────────
def run_required_self_test_if_needed(corpus_root: str) -> None:
    real_root = os.path.realpath(corpus_root)
    if real_root != OASIS_X_ROOT and not real_root.startswith(OASIS_X_ROOT + os.sep):
        return
    _log("info", f"corpus root {os.path.basename(corpus_root)!r} is under oasis-x -- running required self-test")
    test_path = REPO_ROOT / "scripts" / "tests" / "test_nested_shield_exclusion.py"
    import subprocess

    proc = subprocess.run([sys.executable, str(test_path)], capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        _log("error", "required nested-shield self-test FAILED -- refusing to build")
        sys.stderr.write(proc.stdout + proc.stderr)
        sys.exit(1)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--corpus", required=True, choices=sorted(CORPORA.keys()))
    ap.add_argument("--bot", help="targeted rebuild for one bot only (used by bots/Makefile after drift is detected)")
    args = ap.parse_args()

    corpus_id = args.corpus
    corpus_root = CORPORA[corpus_id]
    run_required_self_test_if_needed(corpus_root)

    glob_patterns, deny_dirs = load_deny_lists()
    started = time.time()
    files = walk_corpus(corpus_root, glob_patterns, deny_dirs)
    files, n_gitignored = filter_gitignored(corpus_root, files)
    if n_gitignored:
        _log("info", f"gitignore filter dropped {n_gitignored} file(s)")
    con = open_cache_db()
    try:
        embed_and_cache_corpus(con, files, corpus_id)
    finally:
        con.close()

    bots = [args.bot] if args.bot else authz.all_known_bots()
    tasks = [(bot, str(CACHE_DB), corpus_id) for bot in bots]
    with multiprocessing.Pool(processes=max(1, len(tasks))) as pool:
        results = pool.map(distribute_for_bot, tasks)

    for bot, count in results:
        print(f"{bot}: {count} chunks" if count else f"{bot}: no authorized content (no file written)")
    elapsed = time.time() - started
    _log("info", f"build complete corpus={corpus_id} elapsed_s={elapsed:.1f} bots={len(results)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
