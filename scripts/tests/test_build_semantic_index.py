#!/usr/bin/env python3
"""Tests for the PURE logic in build-semantic-index.py — chunking and the
deny-list matcher — that need no live embedding service, no real corpus, and
no filesystem writes. The security-critical pieces (safe_open_for_read, the
nested-shield exclusion procedure) have their own dedicated tests:
test_nested_shield_exclusion.py, and safe_open_for_read is exercised as part
of a live end-to-end build run rather than mocked here, since faithfully
simulating its OS-level race window in a unit test is what search.ts's own
mocked-lstat test (extensions/oasis-find/src/tests/search.test.ts) does for
the Node-side twin of this exact function — this file does not repeat that.

Run directly: python3 scripts/tests/test_build_semantic_index.py
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

loader = importlib.machinery.SourceFileLoader("build_semantic_index", str(REPO_ROOT / "scripts" / "build-semantic-index.py"))
spec = importlib.util.spec_from_loader("build_semantic_index", loader)
bsi = importlib.util.module_from_spec(spec)
# Register in sys.modules BEFORE exec_module: the target module uses @dataclass,
# whose type-resolution logic does sys.modules.get(cls.__module__) while the
# class body is still executing — without this line that lookup finds nothing
# and dataclass() raises, purely an artifact of the manual-load pattern.
sys.modules["build_semantic_index"] = bsi
loader.exec_module(bsi)


def assert_chunk_text_covers_all_lines_no_gaps() -> None:
    lines = [f"line {i}" for i in range(50)]
    chunks = bsi.chunk_text(lines, max_chars=200, overlap_lines=5)
    assert len(chunks) > 1, "fixture should force multiple chunks"
    # Every line index (1-based) must be covered by at least one chunk.
    covered = set()
    for c in chunks:
        for ln in range(c.line_start, c.line_end + 1):
            covered.add(ln)
    assert covered == set(range(1, 51)), f"gap in coverage: missing {set(range(1, 51)) - covered}"


def assert_chunk_text_overlaps_between_consecutive_chunks() -> None:
    lines = [f"line {i}" * 3 for i in range(60)]  # force several chunks
    chunks = bsi.chunk_text(lines, max_chars=300, overlap_lines=5)
    assert len(chunks) >= 3
    for a, b in zip(chunks, chunks[1:]):
        assert b.line_start <= a.line_end, (
            f"expected overlap between chunk ending at {a.line_end} and next "
            f"starting at {b.line_start} — a match near a chunk boundary "
            "could be split away from its context without one"
        )


def assert_chunk_text_handles_empty_input() -> None:
    assert bsi.chunk_text([]) == []


def assert_chunk_text_single_short_file_is_one_chunk() -> None:
    chunks = bsi.chunk_text(["only line"])
    assert len(chunks) == 1
    assert chunks[0].line_start == 1
    assert chunks[0].line_end == 1


def assert_chunk_text_oversized_single_line_does_not_hang_or_crash() -> None:
    # A degenerate case (one minified line far exceeding max_chars) must
    # still terminate and produce output, not loop forever or raise.
    lines = ["x" * 5000, "short"]
    chunks = bsi.chunk_text(lines, max_chars=1200)
    assert len(chunks) >= 1
    covered = set()
    for c in chunks:
        for ln in range(c.line_start, c.line_end + 1):
            covered.add(ln)
    assert covered == {1, 2}


def assert_deny_glob_matches_mirror_search_ts_semantics() -> None:
    patterns = [bsi._glob_to_regex(g) for g in [".env*", "*.pem", "id_*", "*.env"]]
    must_deny = [".env", ".env.local", "server.pem", "id_rsa", "id_ed25519", "prod.env"]
    must_allow = ["envelope.py", "identity.py", "openclaw.json", "readme.md"]
    for name in must_deny:
        assert bsi.is_denied_name(name, patterns), f"expected {name!r} to be denied"
    for name in must_allow:
        assert not bsi.is_denied_name(name, patterns), f"expected {name!r} to be allowed"


def assert_deny_glob_is_case_insensitive() -> None:
    patterns = [bsi._glob_to_regex("*.PEM".lower())]
    assert bsi.is_denied_name("Server.Pem", patterns)


def assert_real_deny_lists_file_loads_and_matches_known_entries() -> None:
    """The single-source file itself (extensions/oasis-find/src/deny-lists.json)
    must exist, parse, and produce the same deny decision search.ts's own
    tests assert for the same filenames — this is the cross-language
    consistency check the design's header decision 2 exists to guarantee."""
    glob_patterns, deny_dirs = bsi.load_deny_lists()
    assert bsi.is_denied_name(".env", glob_patterns)
    assert bsi.is_denied_name("id_rsa", glob_patterns)
    assert not bsi.is_denied_name("sentinel_registry.py", glob_patterns)
    assert "node_modules" in deny_dirs
    assert "pliny" in deny_dirs
    assert "exp_venv" in deny_dirs, (
        "exp_venv must stay in the shared deny-dirs list -- without it, 94% "
        "of the .py files under a real corpus this project already indexes "
        "(21,041 of 22,360) turned out to be vendored library source, not "
        "this project's own code. This is a REGRESSION test for that finding."
    )


def assert_walk_corpus_excludes_vendored_venv_by_directory_name() -> None:
    """The exp_venv finding, reproduced in miniature: a walk over a small
    fixture tree containing a vendored-look-alike venv directory must never
    surface content from inside it, regardless of that content's extension."""
    tmp = tempfile.mkdtemp(prefix="claw094-walk-test-")
    try:
        os.makedirs(f"{tmp}/exp_venv/lib/site-packages", exist_ok=True)
        with open(f"{tmp}/exp_venv/lib/site-packages/vendored.py", "w") as f:
            f.write("# vendored library code, must never be walked")
        with open(f"{tmp}/real_module.py", "w") as f:
            f.write("# this project's own code")
        glob_patterns, deny_dirs = bsi.load_deny_lists()
        files = bsi.walk_corpus(tmp, glob_patterns, deny_dirs)
        paths = [f.real_path for f in files]
        assert any(p.endswith("real_module.py") for p in paths)
        assert not any("exp_venv" in p for p in paths)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def assert_walk_corpus_applies_the_semantic_index_extension_allowlist() -> None:
    """The second half of the same real-corpus finding: even outside a
    vendored directory, a data-cache file (e.g. a market-data .json blob)
    must not enter a persistent, cost-bearing embedding index just because it
    is not deny-globbed. is_denied_name is a SEPARATE, negative check (secret
    shapes); this is a positive allowlist specific to the semantic-index
    builder, deliberately NOT applied to fs_grep/fs_glob's shared walk — see
    SEMANTIC_INDEX_ALLOWED_EXTENSIONS' own comment for why the asymmetry is
    correct rather than an inconsistency to fix."""
    tmp = tempfile.mkdtemp(prefix="claw094-walk-test-")
    try:
        with open(f"{tmp}/source.py", "w") as f:
            f.write("real code")
        with open(f"{tmp}/data_cache.json", "w") as f:
            f.write('{"not": "code"}')
        with open(f"{tmp}/notes.md", "w") as f:
            f.write("# real docs")
        glob_patterns, deny_dirs = bsi.load_deny_lists()
        files = bsi.walk_corpus(tmp, glob_patterns, deny_dirs)
        names = {os.path.basename(f.real_path) for f in files}
        assert names == {"source.py", "notes.md"}, f"got {names}"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def assert_secret_pattern_catches_aws_access_key_id() -> None:
    assert bsi.find_secret_pattern('aws_key = "AKIAIOSFODNN7EXAMPLE"') == "aws_access_key_id"


def assert_secret_pattern_catches_generic_assignment_like_real_my_secrets_file() -> None:
    """A representative secrets-file layout — regression test for
    generic_secret_assignment detection (see SECRET_PATTERNS' own comment)."""
    text = (
        'tradier_token = "NOTAREALTOKENEXAMPLEPLACEHOLDER0000"\n'
        'gemini_api_key = "AQ.NOTREALEXAMPLEPLACEHOLDER_d3vjNOTAKEY"\n'
        'bedrock_aws_secret_access_key = "wJalrXUtnFEMI/K7MDENGEXAMPLEbPxRfiCYFAKE"\n'
    )
    assert bsi.find_secret_pattern(text) == "generic_secret_assignment"


def assert_secret_pattern_does_not_flag_ordinary_code() -> None:
    text = (
        "def get_quote(symbol: str) -> dict:\n"
        '    return {"symbol": symbol, "price": 100.0}\n'
        'API_BASE = "https://api.weather.oasis-x.io"\n'
    )
    assert bsi.find_secret_pattern(text) is None


def assert_secret_pattern_does_not_false_positive_on_path_suffix_lookalike() -> None:
    """kalshi_private_key_path is a PATH to a key file, not a key literal —
    the identifier does not end in one of the tracked suffixes immediately
    before the assignment, so this must not match."""
    text = 'kalshi_private_key_path = "exp_pmt.txt"'
    assert bsi.find_secret_pattern(text) is None


def assert_filter_gitignored_respects_nested_gitignore_and_negation() -> None:
    tmp = tempfile.mkdtemp(prefix="claw096-gitignore-test-")
    try:
        subprocess.run(["git", "init", "-q", tmp], check=True)
        with open(f"{tmp}/.gitignore", "w") as f:
            f.write("my_secrets.py\nnested/*.tfvars\n!nested/keep.tfvars\n")
        os.makedirs(f"{tmp}/nested", exist_ok=True)
        with open(f"{tmp}/my_secrets.py", "w") as f:
            f.write("secret = 1")
        with open(f"{tmp}/real_module.py", "w") as f:
            f.write("real = 1")
        with open(f"{tmp}/nested/real.tfvars", "w") as f:
            f.write("x = 1")
        with open(f"{tmp}/nested/keep.tfvars", "w") as f:
            f.write("x = 1")
        candidates = [
            bsi.ScannedFile(real_path=os.path.realpath(p), mtime_ns=0)
            for p in [
                f"{tmp}/my_secrets.py",
                f"{tmp}/real_module.py",
                f"{tmp}/nested/real.tfvars",
                f"{tmp}/nested/keep.tfvars",
            ]
        ]
        kept, n_dropped = bsi.filter_gitignored(tmp, candidates)
        kept_names = {os.path.basename(f.real_path) for f in kept}
        assert kept_names == {"real_module.py", "keep.tfvars"}, f"got {kept_names}"
        assert n_dropped == 2
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def assert_filter_gitignored_falls_back_when_not_a_git_repo() -> None:
    """Not embedded in a git work tree at all -> filtering must be a no-op
    (files pass through), never a silent "nothing is ignored" that looks
    identical to a working, permissive result — that distinction is why
    filter_gitignored also returns a drop count callers must log."""
    tmp = tempfile.mkdtemp(prefix="claw096-nogit-test-")
    try:
        with open(f"{tmp}/module.py", "w") as f:
            f.write("x = 1")
        candidates = [bsi.ScannedFile(real_path=os.path.realpath(f"{tmp}/module.py"), mtime_ns=0)]
        kept, n_dropped = bsi.filter_gitignored(tmp, candidates)
        assert len(kept) == 1
        assert n_dropped == 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def assert_purge_stale_chunk_sources_removes_previously_recorded_rows() -> None:
    """Regression test for the CLAW-096 finding: filter_gitignored() and
    find_secret_pattern() alone stop a NEW build from re-inserting an
    excluded file, but distribute_for_bot() reads chunk_sources' full,
    accumulated contents unconditionally -- so a row from a PRIOR build, for
    a file the current walk no longer includes, must be actively deleted or
    it is redistributed to every bot forever, unchanged."""
    con = sqlite3.connect(":memory:")
    con.execute(
        """CREATE TABLE chunk_sources (
             content_sha256   TEXT NOT NULL,
             source_host_path TEXT NOT NULL,
             source_mtime_ns  INTEGER NOT NULL,
             line_start       INTEGER NOT NULL,
             line_end         INTEGER NOT NULL,
             corpus_id        TEXT NOT NULL,
             PRIMARY KEY (content_sha256, source_host_path)
           )"""
    )
    con.execute(
        "INSERT INTO chunk_sources VALUES ('h1', '/exp/my_secrets.py', 0, 1, 1, 'exp')"
    )
    con.execute(
        "INSERT INTO chunk_sources VALUES ('h2', '/exp/real_module.py', 0, 1, 1, 'exp')"
    )
    con.execute(
        "INSERT INTO chunk_sources VALUES ('h3', '/oasis-x/other.py', 0, 1, 1, 'oasis-x')"
    )
    con.commit()
    n_removed = bsi.purge_stale_chunk_sources(con, "exp")
    assert n_removed == 2, f"expected 2 rows removed for corpus='exp', got {n_removed}"
    remaining = {
        row[0] for row in con.execute("SELECT source_host_path FROM chunk_sources").fetchall()
    }
    assert remaining == {"/oasis-x/other.py"}, (
        f"purge must be scoped to the given corpus_id only -- a future second "
        f"corpus's rows must survive a purge of 'exp', got {remaining}"
    )


def main() -> int:
    checks = [
        assert_chunk_text_covers_all_lines_no_gaps,
        assert_chunk_text_overlaps_between_consecutive_chunks,
        assert_chunk_text_handles_empty_input,
        assert_chunk_text_single_short_file_is_one_chunk,
        assert_chunk_text_oversized_single_line_does_not_hang_or_crash,
        assert_deny_glob_matches_mirror_search_ts_semantics,
        assert_deny_glob_is_case_insensitive,
        assert_real_deny_lists_file_loads_and_matches_known_entries,
        assert_walk_corpus_excludes_vendored_venv_by_directory_name,
        assert_walk_corpus_applies_the_semantic_index_extension_allowlist,
        assert_secret_pattern_catches_aws_access_key_id,
        assert_secret_pattern_catches_generic_assignment_like_real_my_secrets_file,
        assert_secret_pattern_does_not_flag_ordinary_code,
        assert_secret_pattern_does_not_false_positive_on_path_suffix_lookalike,
        assert_filter_gitignored_respects_nested_gitignore_and_negation,
        assert_filter_gitignored_falls_back_when_not_a_git_repo,
        assert_purge_stale_chunk_sources_removes_previously_recorded_rows,
    ]
    failed = 0
    for check in checks:
        try:
            check()
        except AssertionError as exc:
            print(f"FAIL: {check.__name__}: {exc}", file=sys.stderr)
            failed += 1
        else:
            print(f"PASS: {check.__name__}")
    if failed:
        print(f"\n{failed} check(s) FAILED", file=sys.stderr)
        return 1
    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
