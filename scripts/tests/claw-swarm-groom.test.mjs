import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { checkBoard, findBoards, githubSlug, groom, isFresh, parseItems, pathRefs, prRefs, toMarkdown } from "../claw-swarm-groom.mjs";

const NOW = Date.parse("2026-11-02T23:30:00Z");
const DAY = 24 * 3600 * 1000;

let dirs = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "groom-test-"));
  dirs.push(root);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

function age(root, p, days) {
  const t = new Date(NOW - days * DAY);
  utimesSync(join(root, p), t, t);
}

/** git and gh fakes: no subprocess in tests. */
const noGit = { top: () => null, fetch: () => null, lastCommit: () => 0, fileCommit: () => 0, dirty: () => 0, remote: () => null };
function fakeGh(states = {}, lastPr = null) {
  return { lastPr: () => lastPr, prState: (slug, n) => states[`${slug}#${n}`] ?? null, calls: 0 };
}

describe("findBoards", () => {
  it("finds .swarm folders and skips node_modules, vendor, worktrees and Fairskies", () => {
    const root = tree({
      "a/.swarm/queue.md": "",
      "a/sub/.swarm/queue.md": "",
      "node_modules/x/.swarm/queue.md": "",
      "a/vendor/y/.swarm/queue.md": "",
      "oasis-x-worktrees/z/.swarm/queue.md": "",
      "oasis-fairskies-wds/.swarm/queue.md": "",
    });
    const found = findBoards(root).map((p) => p.slice(root.length + 1));
    assert.deepEqual(found, ["a/.swarm", "a/sub/.swarm"]);
  });
});

describe("isFresh", () => {
  it("is fresh when any source changed in the window", () => {
    assert.equal(isFresh({ swarmMtime: NOW - 10 * DAY, lastCommit: NOW - 9 * DAY, lastPr: NOW - 2 * DAY }, NOW, 7).fresh, true);
    assert.equal(isFresh({ swarmMtime: NOW - 1 * DAY }, NOW, 7).fresh, true);
  });
  it("NEGATIVE CONTROL: not fresh when every source is older than the window, or missing", () => {
    assert.equal(isFresh({ swarmMtime: NOW - 8 * DAY, lastCommit: NOW - 30 * DAY, lastPr: 0 }, NOW, 7).fresh, false);
    assert.equal(isFresh({}, NOW, 7).fresh, false);
  });
});

describe("parsing", () => {
  it("parses items with marker, ID, tag, title, line and block", () => {
    const items = parseItems("# Queue\n\n## Active\n\n- [~] [CLD-090] [BUILT · 2026-10-27] Backfill\n  note line\n- [x] [CLD-086] [DONE] Done item\n## Done\n");
    assert.equal(items.length, 2);
    assert.deepEqual({ ...items[0], block: undefined }, { marker: "~", id: "CLD-090", tag: "BUILT · 2026-10-27", title: "Backfill", line: 5, block: undefined });
    assert.match(items[0].block, /note line/);
  });
  it("reads PR refs in three forms and backticked paths", () => {
    const refs = prRefs("see https://github.com/o/r/pull/4 and o/other#7 and PR #12", "o/r").map((r) => `${r.slug}#${r.n}`);
    assert.deepEqual(refs.sort(), ["o/other#7", "o/r#12", "o/r#4"]);
    assert.deepEqual(pathRefs("`src/a.py:12` `docs/` `https://x.y/z.md` `/abs/p.md` `word` `a/*.md`"), ["src/a.py", "docs/"]);
  });
  it("NEGATIVE CONTROL: \"openclaw PR #N\" and \"oasis-cloud PR #N\" are not PRs of the board's own repo", () => {
    const refs = prRefs("openclaw PR #117372; oasis-cloud PR #33; oasis-claw PR #2", "oasis-main/oasis-claw").map((r) => `${r.slug}#${r.n}`);
    assert.deepEqual(refs.sort(), ["oasis-main/oasis-claw#2", "oasis-main/oasis-cloud#33", "oasis-main/openclaw#117372"]);
  });
  it("reads GitHub slugs from https and ssh remotes", () => {
    assert.equal(githubSlug("https://github.com/oasis-main/oasis-claw.git"), "oasis-main/oasis-claw");
    assert.equal(githubSlug("git@github.com:MikeHLee/exp.git"), "MikeHLee/exp");
    assert.equal(githubSlug("https://gitlab.com/x/y"), null);
  });
});

describe("checkBoard", () => {
  const board = (root) => ({ swarm: join(root, "r/.swarm"), parent: join(root, "r"), root, top: null, slug: "o/r" });

  it("flags merged-but-open, stale claims, missing paths, duplicate IDs and a stale state.md", () => {
    const root = tree({
      "r/.swarm/queue.md": [
        "## Active",
        "- [~] [X-1] [BUILT · 2026-10-30] shipped in PR #4",
        "- [>] [X-2] [CLAIMED · 2026-09-01] old claim",
        "- [ ] [X-3] [OPEN · 2026-11-01] see `src/missing.py`, `src/here.py`, `fleet/note.md` and `other-repo/x.py`",
        "- [ ] [X-1] [OPEN] second use of X-1",
        "- [x] [X-4] [DONE · 2026-01-01] merged PR #5, done",
      ].join("\n"),
      "r/.swarm/state.md": "old",
      "r/src/here.py": "",
      "r/.swarm/fleet/note.md": "",
    });
    age(root, "r/.swarm/state.md", 40);
    const f = checkBoard(board(root), { git: noGit, gh: fakeGh({ "o/r#4": "merged", "o/r#5": "merged" }), now: NOW });
    const by = (c) => f.filter((x) => x.check === c);
    assert.deepEqual(by("merged-but-open").map((x) => x.id), ["X-1"]);
    assert.deepEqual(by("stale-claim").map((x) => x.id), ["X-2"]);
    assert.deepEqual(by("missing-path").map((x) => x.says), ["`src/missing.py`"]);
    assert.deepEqual(by("duplicate-id").map((x) => x.line), [5]);
    assert.equal(by("state-behind").length, 1);
  });

  it("NEGATIVE CONTROL: an open PR, a recent claim and a done item give no finding", () => {
    const root = tree({ "r/.swarm/queue.md": "- [~] [X-1] [BUILT · 2026-10-30] PR #4 in review\n- [x] [X-2] [DONE] PR #5\n" });
    const f = checkBoard(board(root), { git: noGit, gh: fakeGh({ "o/r#4": "open", "o/r#5": "merged" }), now: NOW });
    assert.deepEqual(f, []);
  });
});

describe("groom", () => {
  it("checks only fresh boards and lists the rest as skipped", () => {
    const root = tree({
      "new/.swarm/queue.md": "- [ ] [N-1] [OPEN] `gone/file.md`\n",
      "new/gone/other.md": "",
      "old/.swarm/queue.md": "- [ ] [O-1] [OPEN] `gone/file.md`\n",
      "old/gone/other.md": "",
    });
    age(root, "old/.swarm/queue.md", 30);
    age(root, "new/.swarm/queue.md", 1);
    const r = groom({ root, days: 7, now: NOW, git: noGit, gh: fakeGh() });
    const byName = Object.fromEntries(r.boards.map((b) => [b.name, b]));
    assert.equal(byName.new.fresh, true);
    assert.equal(byName.new.findings.length, 1);
    assert.equal(byName.old.fresh, false);
    assert.deepEqual(byName.old.findings, []);
    const md = toMarkdown(r);
    assert.match(md, /### new/);
    assert.match(md, /\| old \| 2026-10-03 \|/);
  });

  it("a stale clone with recent PR activity is fresh (oasis-firmware, 2026-11-02)", () => {
    const root = tree({ "fw/.swarm/queue.md": "- [ ] [FW-1] [OPEN]\n" });
    age(root, "fw/.swarm/queue.md", 100);
    const git = { ...noGit, top: (d) => d, remote: () => "https://github.com/o/fw.git", lastCommit: () => NOW - 150 * DAY };
    const r = groom({ root, days: 7, now: NOW, git, gh: fakeGh({}, NOW - 3 * DAY) });
    assert.equal(r.boards[0].fresh, true);
    assert.equal(r.boards[0].github, "ok");
  });
});
