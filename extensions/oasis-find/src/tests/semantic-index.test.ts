import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSemanticIndex, topK, getCurrentIndex, type Manifest, type MetaLine } from "../semantic-index.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-index-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes a valid (vectors, meta, manifest) triplet, mirroring exactly what
 * build-semantic-index.py's _write_bot_triplet produces, so these tests
 * exercise the same wire format the Python side actually writes. */
function writeTriplet(
  dir: string,
  corpus: string,
  opts: {
    buildId?: string;
    vectors: number[][];
    metaOverride?: Partial<MetaLine>[];
    manifestOverride?: Partial<Manifest>;
    corruptTrailer?: boolean;
    dropLastMetaLine?: boolean;
    wrongBuildIdOnOneLine?: boolean;
  },
): void {
  const buildId = opts.buildId ?? "11111111-1111-1111-1111-111111111111";
  const dim = opts.vectors[0]?.length ?? 0;
  const count = opts.vectors.length;

  const vecBuf = Buffer.alloc(count * dim * 4 + 36);
  opts.vectors.forEach((v, i) => {
    v.forEach((x, d) => vecBuf.writeFloatLE(x, (i * dim + d) * 4));
  });
  const trailer = opts.corruptTrailer ? "0".repeat(36) : buildId;
  vecBuf.write(trailer, count * dim * 4, "ascii");
  fs.writeFileSync(path.join(dir, `${corpus}.vectors.f32`), vecBuf);

  const metaLines: MetaLine[] = opts.vectors.map((_, i) => ({
    path: `/reach/exp/file${i}.py`,
    line_start: 1,
    line_end: 1,
    text: `chunk ${i}`,
    content_sha256: `hash${i}`,
    source_mtime_ns: 0,
    build_id: buildId,
    ...(opts.metaOverride?.[i] ?? {}),
  }));
  if (opts.wrongBuildIdOnOneLine && metaLines.length > 0) {
    metaLines[0] = { ...metaLines[0], build_id: "wrong-build-id" };
  }
  let lines = metaLines.map((m) => JSON.stringify(m));
  if (opts.dropLastMetaLine) lines = lines.slice(0, -1);
  fs.writeFileSync(path.join(dir, `${corpus}.meta.jsonl`), lines.join("\n") + "\n");

  const manifest: Manifest = {
    bot: "house",
    corpus,
    model: "default",
    dim,
    count,
    normalized: true,
    built_at: "2026-08-14T00:00:00Z",
    build_id: buildId,
    authorized_roots: ["/Users/Michaellee/Documents/Runes/exp"],
    ...(opts.manifestOverride ?? {}),
  };
  fs.writeFileSync(path.join(dir, `${corpus}.manifest.json`), JSON.stringify(manifest));
}

describe("loadSemanticIndex", () => {
  it("loads a well-formed triplet", () => {
    writeTriplet(dir, "exp", { vectors: [[1, 0, 0], [0, 1, 0]] });
    const idx = loadSemanticIndex(dir, "exp");
    expect(idx).not.toBeNull();
    expect(idx!.count).toBe(2);
    expect(idx!.dim).toBe(3);
    expect(idx!.meta).toHaveLength(2);
    expect(Array.from(idx!.vectors)).toEqual([1, 0, 0, 0, 1, 0]);
  });

  it("returns null when the manifest is missing", () => {
    expect(loadSemanticIndex(dir, "exp")).toBeNull();
  });

  it("returns null when the vectors file is missing", () => {
    writeTriplet(dir, "exp", { vectors: [[1, 0]] });
    fs.rmSync(path.join(dir, "exp.vectors.f32"));
    expect(loadSemanticIndex(dir, "exp")).toBeNull();
  });

  it("returns null when the vectors file trailer does not match the manifest build_id", () => {
    // Directly exercises the atomic-rename crash-window defense (design
    // section 7): a reader must never trust a vectors file whose trailer
    // disagrees with the manifest's build_id, independent of whether the
    // chunk COUNT happens to also differ.
    writeTriplet(dir, "exp", { vectors: [[1, 0]], corruptTrailer: true });
    expect(loadSemanticIndex(dir, "exp")).toBeNull();
  });

  it("returns null when meta.jsonl has fewer lines than manifest.count", () => {
    writeTriplet(dir, "exp", { vectors: [[1, 0], [0, 1]], dropLastMetaLine: true });
    expect(loadSemanticIndex(dir, "exp")).toBeNull();
  });

  it("returns null when even ONE metadata line disagrees on build_id", () => {
    writeTriplet(dir, "exp", { vectors: [[1, 0], [0, 1]], wrongBuildIdOnOneLine: true });
    expect(loadSemanticIndex(dir, "exp")).toBeNull();
  });

  it("returns null on a malformed manifest JSON", () => {
    fs.writeFileSync(path.join(dir, "exp.manifest.json"), "{not json");
    expect(loadSemanticIndex(dir, "exp")).toBeNull();
  });
});

describe("topK", () => {
  it("ranks by dot product, best first", () => {
    writeTriplet(dir, "exp", {
      vectors: [
        [1, 0, 0], // orthogonal to query
        [0, 1, 0], // matches query exactly
        [0.7071, 0.7071, 0], // 45 degrees off
      ],
    });
    const idx = loadSemanticIndex(dir, "exp")!;
    const query = new Float32Array([0, 1, 0]);
    const top = topK(idx, query, 3);
    expect(top.map((c) => c.index)).toEqual([1, 2, 0]);
    expect(top[0].score).toBeCloseTo(1, 5);
    expect(top[2].score).toBeCloseTo(0, 5);
  });

  it("respects k", () => {
    writeTriplet(dir, "exp", { vectors: [[1, 0], [0, 1], [1, 1]] });
    const idx = loadSemanticIndex(dir, "exp")!;
    const top = topK(idx, new Float32Array([1, 0]), 1);
    expect(top).toHaveLength(1);
  });

  it("returns empty for a dimension mismatch rather than throwing", () => {
    writeTriplet(dir, "exp", { vectors: [[1, 0, 0]] });
    const idx = loadSemanticIndex(dir, "exp")!;
    expect(topK(idx, new Float32Array([1, 0]), 5)).toEqual([]);
  });

  it("carries the right meta entry for each scored candidate", () => {
    writeTriplet(dir, "exp", {
      vectors: [[1, 0], [0, 1]],
      metaOverride: [{ path: "/reach/exp/a.py" }, { path: "/reach/exp/b.py" }],
    });
    const idx = loadSemanticIndex(dir, "exp")!;
    const top = topK(idx, new Float32Array([0, 1]), 2);
    expect(top[0].meta.path).toBe("/reach/exp/b.py");
  });
});

describe("getCurrentIndex — the reload gate", () => {
  it("loads on first call", () => {
    writeTriplet(dir, "exp", { vectors: [[1, 0]], buildId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
    const idx = getCurrentIndex(dir, "exp");
    expect(idx?.buildId).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  });

  it("reloads when build_id changes between calls", () => {
    writeTriplet(dir, "exp", { vectors: [[1, 0]], buildId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
    const first = getCurrentIndex(dir, "exp");
    expect(first?.count).toBe(1);

    writeTriplet(dir, "exp", { vectors: [[1, 0], [0, 1]], buildId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
    const second = getCurrentIndex(dir, "exp");
    expect(second?.buildId).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(second?.count).toBe(2);
  });

  it("does NOT reload when build_id is unchanged — same object returned", () => {
    writeTriplet(dir, "exp", { vectors: [[1, 0]], buildId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
    const first = getCurrentIndex(dir, "exp");
    const second = getCurrentIndex(dir, "exp");
    expect(second).toBe(first); // reference equality: no reload happened
  });

  it("keeps serving the last good index if the manifest becomes unreadable mid-rename", () => {
    writeTriplet(dir, "exp", { vectors: [[1, 0]], buildId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
    const good = getCurrentIndex(dir, "exp");
    expect(good).not.toBeNull();

    fs.rmSync(path.join(dir, "exp.manifest.json")); // simulate the mid-rename gap
    const duringGap = getCurrentIndex(dir, "exp");
    expect(duringGap).toBe(good); // still serving the last good load, not null
  });

  it("keeps serving the last good index if a new build fails validation", () => {
    writeTriplet(dir, "exp", { vectors: [[1, 0]], buildId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
    const good = getCurrentIndex(dir, "exp");

    // A new manifest claiming a new build_id, but the vectors file was never
    // updated to match (simulates a genuine crash between the vectors rename
    // and the metadata rename, still visible to a reader before the retry).
    writeTriplet(dir, "exp", {
      vectors: [[1, 0]],
      buildId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      corruptTrailer: true,
    });
    const duringBadBuild = getCurrentIndex(dir, "exp");
    expect(duringBadBuild).toBe(good); // never serves the invalid new build
  });

  it("returns null (never throws) when nothing has ever loaded and the manifest is absent", () => {
    expect(getCurrentIndex(dir, "exp")).toBeNull();
  });
});
