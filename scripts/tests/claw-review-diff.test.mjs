// Tests for claw-review-diff (CLAW-091). The pure classifier is tested against
// paths directly (no git needed); one integration test drives it against a
// REAL temporary git repo to prove the git-diff plumbing itself works, not
// just the pattern matching.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyDiff, changedPaths, CATEGORY_1_RULES } from "../claw-review-diff.mjs";

describe("classifyDiff — category-1 (self-governing) path detection", () => {
  it("flags every category-1 example named in BOT_REPO_CONTRIBUTION_DESIGN.md", () => {
    const paths = [
      "patches/foo.patch",
      "scripts/claw-mail-relay.mjs",
      "scripts/claw-mail-routes.json",
      "scripts/git-policy/allow.json",
      "scripts/runtime-entrypoint.sh",
      "scripts/compile-role.py",
      "scripts/audit-sandbox.sh",
      "sandbox/docker-compose.sandbox-runtime.yml",
      "Dockerfile.runtime",
      "docker-compose.runtime.yml",
      "bots/docker-compose.house-reach.yml",
      ".swarm/queue.md",
      ".gitignore",
      "extensions/oasis-reviewer/src/policy.ts",
    ];
    const { flagged, clean } = classifyDiff(paths);
    expect(flagged.map((f) => f.path).sort()).toEqual([...paths].sort());
    expect(clean).toEqual([]);
  });

  it("does NOT flag ordinary product paths — docs, blog, product code, tests", () => {
    const paths = [
      "README.md",
      "docs/architecture.md",
      "blog/2026-09-04-launch.md",
      "packages/some-lib/src/index.ts",
      "packages/some-lib/src/index.test.ts",
      "AUDIT_LOG.md",
    ];
    const { flagged, clean } = classifyDiff(paths);
    expect(flagged).toEqual([]);
    expect(clean).toEqual(paths);
  });

  it("scripts/claw-* only matches files DIRECTLY in scripts/, not a coincidentally-named file elsewhere", () => {
    // A file named claw-something outside scripts/ is a different, unrelated
    // thing (e.g. a product doc mentioning CLAW-090) and must not be flagged.
    const { flagged, clean } = classifyDiff(["docs/claw-090-summary.md", "scripts/claw-mail-waker.mjs"]);
    expect(clean).toEqual(["docs/claw-090-summary.md"]);
    expect(flagged.map((f) => f.path)).toEqual(["scripts/claw-mail-waker.mjs"]);
  });

  it("a nested docker-compose*.yml at any depth is flagged, not just the repo root", () => {
    const { flagged } = classifyDiff(["some/deep/nested/dir/docker-compose.override.yml"]);
    expect(flagged).toHaveLength(1);
  });

  it("does not confuse a 'patches' PREFIX with the patches/ directory (e.g. patches-notes.md)", () => {
    const { flagged, clean } = classifyDiff(["patches-notes.md"]);
    expect(flagged).toEqual([]);
    expect(clean).toEqual(["patches-notes.md"]);
  });

  it("has no duplicate or overlapping rule names (each path matches at most one documented rule)", () => {
    const names = CATEGORY_1_RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("changedPaths + classifyDiff — real git repo integration", () => {
  function git(repo, args) {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  }

  it("detects a category-1 change across two real branches in a scratch repo", () => {
    const repo = mkdtempSync(join(tmpdir(), "claw-review-diff-"));
    git(repo, ["init", "-q", "-b", "dev"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "README.md"), "hello\n");
    writeFileSync(join(repo, "scripts", "runtime-entrypoint.sh"), "#!/bin/sh\necho original\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    git(repo, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(repo, "README.md"), "hello, updated\n");
    writeFileSync(join(repo, "scripts", "runtime-entrypoint.sh"), "#!/bin/sh\necho MODIFIED\n");
    git(repo, ["commit", "-q", "-am", "feature work"]);

    const paths = changedPaths(repo, "dev", "feature");
    const { flagged, clean } = classifyDiff(paths);
    expect(clean).toEqual(["README.md"]);
    expect(flagged.map((f) => f.path)).toEqual(["scripts/runtime-entrypoint.sh"]);
  });

  it("reports clean when a real branch only touches category-2 paths", () => {
    const repo = mkdtempSync(join(tmpdir(), "claw-review-diff-clean-"));
    git(repo, ["init", "-q", "-b", "dev"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    git(repo, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(repo, "README.md"), "hello, only docs changed\n");
    git(repo, ["commit", "-q", "-am", "docs"]);

    const paths = changedPaths(repo, "dev", "feature");
    const { flagged } = classifyDiff(paths);
    expect(flagged).toEqual([]);
  });

  it("changedPaths throws (never silently returns empty) on an invalid ref, so a broken check fails loud", () => {
    const repo = mkdtempSync(join(tmpdir(), "claw-review-diff-badref-"));
    git(repo, ["init", "-q", "-b", "dev"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    expect(() => changedPaths(repo, "dev", "this-ref-does-not-exist")).toThrow();
  });
});
