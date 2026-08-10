import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DENY_DIRS,
  DEFAULT_DENY_GLOBS,
  DEFAULT_SEARCH_LIMITS,
  globToRegExp,
  grepFiles,
  isDenied,
  looksBinary,
  resolveInsideRoots,
  walkFiles,
  type SearchConfig,
} from "../search.js";

let tmp: string;
let root: string;
let outside: string;

function write(rel: string, body: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
  return abs;
}

function cfg(over: Partial<SearchConfig> = {}): SearchConfig {
  return {
    roots: [root],
    denyGlobs: DEFAULT_DENY_GLOBS,
    denyDirs: DEFAULT_DENY_DIRS,
    ...DEFAULT_SEARCH_LIMITS,
    ...over,
  };
}

beforeEach(() => {
  // realpath: macOS /var is a symlink to /private/var, and the containment
  // check resolves both sides, so a raw mkdtemp path would fail on Mac only.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oasis-find-")));
  root = path.join(tmp, "reach");
  outside = path.join(tmp, "outside");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("globToRegExp", () => {
  it("matches * within a name but not across directories", () => {
    expect(globToRegExp("*.md").test("notes.md")).toBe(true);
    expect(globToRegExp("*.md").test("a/b.md")).toBe(false);
  });
  it("matches ? as exactly one character", () => {
    expect(globToRegExp("CLAW-08?.md").test("CLAW-082.md")).toBe(true);
    expect(globToRegExp("CLAW-08?.md").test("CLAW-0821.md")).toBe(false);
  });
  it("escapes regex metacharacters in the literal part", () => {
    expect(globToRegExp("a+b.md").test("a+b.md")).toBe(true);
    expect(globToRegExp("a+b.md").test("aab.md")).toBe(false);
  });
});

describe("deny rules", () => {
  it("denies every glob the reviewer's denyReadGlobs denies", () => {
    for (const name of ["server.pem", "id_rsa", "x.key", "host_ed25519", ".env", ".env.local", "prod.env"]) {
      expect(isDenied(name, DEFAULT_DENY_GLOBS)).toBe(true);
    }
  });
  it("does not deny ordinary files", () => {
    for (const name of ["README.md", "queue.md", "index.ts", "environment.md"]) {
      expect(isDenied(name, DEFAULT_DENY_GLOBS)).toBe(false);
    }
  });
  it("skips pliny — off-limits sensitive content, not hygiene", () => {
    expect(DEFAULT_DENY_DIRS).toContain("pliny");
  });
});

describe("resolveInsideRoots — containment", () => {
  it("accepts a path inside a root", () => {
    const f = write("a/b.md", "x");
    expect(resolveInsideRoots(f, [root])).toBe(fs.realpathSync(f));
  });
  it("rejects a path outside every root", () => {
    const f = path.join(outside, "secret.md");
    fs.writeFileSync(f, "x");
    expect(resolveInsideRoots(f, [root])).toBeNull();
  });
  it("rejects a dot-dot escape", () => {
    write("a/b.md", "x");
    expect(resolveInsideRoots(path.join(root, "a", "..", "..", "outside"), [root])).toBeNull();
  });
  it("rejects a SYMLINK that points outside the root", () => {
    const target = path.join(outside, "leak.md");
    fs.writeFileSync(target, "secret");
    const link = path.join(root, "innocent.md");
    fs.symlinkSync(target, link);
    // The link LOOKS in-root; realpath is what catches it.
    expect(resolveInsideRoots(link, [root])).toBeNull();
  });
  it("rejects a missing path", () => {
    expect(resolveInsideRoots(path.join(root, "nope.md"), [root])).toBeNull();
  });
});

describe("walkFiles", () => {
  it("finds matching files and orders them newest first", () => {
    const a = write("old.md", "a");
    const b = write("new.md", "b");
    fs.utimesSync(a, new Date(1000), new Date(1000));
    fs.utimesSync(b, new Date(90_000_000), new Date(90_000_000));
    const { files } = walkFiles(cfg(), { accept: (_p, n) => n.endsWith(".md") });
    expect(files.map((f) => path.basename(f.path))).toEqual(["new.md", "old.md"]);
  });

  it("never returns a denied file even when the pattern matches it", () => {
    write(".env", "SECRET=1");
    write("keep.md", "hello");
    const { files } = walkFiles(cfg(), { accept: () => true });
    expect(files.map((f) => path.basename(f.path))).toEqual(["keep.md"]);
  });

  it("does not descend into denied directories", () => {
    write("node_modules/dep/readme.md", "noise");
    write("pliny/secret.md", "off limits");
    write("real.md", "signal");
    const { files } = walkFiles(cfg(), { accept: (_p, n) => n.endsWith(".md") });
    expect(files.map((f) => path.basename(f.path))).toEqual(["real.md"]);
  });

  it("does not follow a symlinked FILE into another tree", () => {
    const target = path.join(outside, "leak.md");
    fs.writeFileSync(target, "secret");
    fs.symlinkSync(target, path.join(root, "link.md"));
    write("real.md", "signal");
    const { files } = walkFiles(cfg(), { accept: (_p, n) => n.endsWith(".md") });
    expect(files.map((f) => path.basename(f.path))).toEqual(["real.md"]);
  });

  it("reports truncation instead of scanning without bound", () => {
    for (let i = 0; i < 30; i += 1) write(`f${i}.md`, "x");
    const { truncated } = walkFiles(cfg({ maxScannedFiles: 5 }), { accept: () => true });
    expect(truncated).toBe(true);
  });

  // CLAW-082 phase 3 regression. House searched /reach for "CLAW-079",
  // /reach/oasis-x consumed the whole shared scan budget, /reach/claw-swarm was
  // never opened, and the tool reported "no matches" for a string that WAS
  // there. A false negative from a search tool is worse than a slow answer.
  it("gives every root a share of the scan budget - a big first root cannot starve a later one", () => {
    const big = path.join(root, "big");
    const small = path.join(root, "small");
    fs.mkdirSync(big, { recursive: true });
    fs.mkdirSync(small, { recursive: true });
    for (let i = 0; i < 200; i += 1) {
      fs.writeFileSync(path.join(big, "noise" + i + ".md"), "noise");
    }
    fs.writeFileSync(path.join(small, "needle.md"), "needle");

    const { files } = walkFiles(cfg({ roots: [big, small], maxScannedFiles: 20 }), {
      accept: (_p, n) => n === "needle.md",
    });
    expect(files.map((f) => path.basename(f.path))).toEqual(["needle.md"]);
  });

  it("rolls a small root's unused budget forward instead of wasting it", () => {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(a, "one.md"), "x");
    for (let i = 0; i < 30; i += 1) fs.writeFileSync(path.join(b, "f" + i + ".md"), "x");
    const { scanned } = walkFiles(cfg({ roots: [a, b], maxScannedFiles: 24 }), {
      accept: () => true,
    });
    expect(scanned).toBeGreaterThan(13);
  });

  it("confines a subpath to the roots", () => {
    write("in/a.md", "x");
    const { files } = walkFiles(cfg(), { subpath: outside, accept: () => true });
    expect(files).toHaveLength(0);
  });
});

describe("grepFiles", () => {
  it("returns path, 1-based line number and the matching text", () => {
    write("a.md", "alpha\nbeta CLAW-082 gamma\ndelta");
    const { files } = walkFiles(cfg(), { accept: () => true });
    const { matches } = grepFiles(cfg(), files, /CLAW-\d+/i);
    expect(matches).toHaveLength(1);
    expect(matches[0].line).toBe(2);
    expect(matches[0].text).toContain("CLAW-082");
  });

  it("caps matches per file", () => {
    write("a.md", Array.from({ length: 50 }, () => "hit").join("\n"));
    const { files } = walkFiles(cfg(), { accept: () => true });
    const { matches } = grepFiles(cfg({ maxMatchesPerFile: 3 }), files, /hit/);
    expect(matches).toHaveLength(3);
  });

  it("skips binary files", () => {
    const abs = path.join(root, "bin.dat");
    fs.writeFileSync(abs, Buffer.from([0x68, 0x69, 0x00, 0x68, 0x69]));
    const { files } = walkFiles(cfg(), { accept: () => true });
    const { matches } = grepFiles(cfg(), files, /hi/);
    expect(matches).toHaveLength(0);
  });

  it("skips files over maxFileBytes", () => {
    write("big.md", "needle\n" + "x".repeat(5000));
    const { files } = walkFiles(cfg(), { accept: () => true });
    const { matches } = grepFiles(cfg({ maxFileBytes: 100 }), files, /needle/);
    expect(matches).toHaveLength(0);
  });

  it("does not skip lines when handed a /g regex", () => {
    write("a.md", "hit\nhit\nhit");
    const { files } = walkFiles(cfg(), { accept: () => true });
    const { matches } = grepFiles(cfg(), files, /hit/g);
    expect(matches).toHaveLength(3);
  });

  it("truncates rather than returning unbounded output", () => {
    for (let i = 0; i < 20; i += 1) write(`f${i}.md`, "needle");
    const { files } = walkFiles(cfg(), { accept: () => true });
    const { matches, truncated } = grepFiles(cfg({ maxResults: 4 }), files, /needle/);
    expect(matches).toHaveLength(4);
    expect(truncated).toBe(true);
  });
});

describe("looksBinary", () => {
  it("flags a NUL byte", () => {
    expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
  });
  it("passes plain text", () => {
    expect(looksBinary(Buffer.from("hello world", "utf8"))).toBe(false);
  });
});
