import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Loader + scorer for a bot's own per-bot semantic search index (CLAW-094).
 *
 * The index is a triplet of files, built host-side by scripts/build-semantic-
 * index.py and delivered via a Docker bind mount into ONE bot's own
 * container — never a shared, network-queryable store. Storage choice is
 * deliberate: this container runs Node on a read-only root filesystem, and
 * the only practical synchronous SQLite binding for Node (better-sqlite3)
 * ships a compiled native addon that needs a writable node_modules and often
 * a C++ toolchain — a poor fit here, and a new class of fragility this
 * extension does not otherwise carry (its only runtime dependency is zod).
 * A flat Float32Array read once with fs.readFileSync, scored with a plain
 * loop, has zero dependencies beyond Node's built-in fs module.
 *
 *   <corpus>.vectors.f32   flat, little-endian float32, D per row, L2-
 *                          normalized at build time, plus a 36-byte ASCII
 *                          build_id trailer (a UUID4 string).
 *   <corpus>.meta.jsonl    one JSON object per line, positionally paired
 *                          with the vectors file (line i <-> vector i), each
 *                          line ALSO carrying the same build_id.
 *   <corpus>.manifest.json {bot, corpus, model, dim, count, build_id, ...}.
 *
 * The build_id cross-check (all three files must agree) is what makes an
 * atomic rename sequence (vectors, then meta, then manifest LAST) safe to
 * read concurrently with a rebuild: any reader that observes a manifest
 * whose build_id does not match what it finds in the other two files simply
 * refuses to load, rather than risking a new vector paired with old
 * metadata (or vice versa) — which a byte-length check alone cannot catch
 * when an old and a new build happen to produce the same chunk count.
 */

export type Manifest = {
  bot: string;
  corpus: string;
  model: string;
  dim: number;
  count: number;
  normalized: boolean;
  built_at: string;
  build_id: string;
  authorized_roots: string[];
};

export type MetaLine = {
  path: string;
  line_start: number;
  line_end: number;
  text: string;
  content_sha256: string;
  source_mtime_ns: number;
  build_id: string;
};

export type LoadedIndex = {
  buildId: string;
  model: string;
  dim: number;
  count: number;
  vectors: Float32Array;
  meta: MetaLine[];
  builtAt: string;
};

const BUILD_ID_TRAILER_BYTES = 36;

function readManifest(dir: string, corpus: string): Manifest | null {
  try {
    const raw = readFileSync(path.join(dir, `${corpus}.manifest.json`), "utf8");
    const m = JSON.parse(raw) as Manifest;
    if (typeof m.build_id !== "string" || typeof m.dim !== "number" || typeof m.count !== "number") return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * Full, validated load of all three files. Returns null on ANY mismatch —
 * missing file, wrong length, wrong trailer, any single metadata line
 * disagreeing on build_id, or a line count that doesn't match the manifest.
 * Never returns a partially-consistent index; the caller (getCurrentIndex)
 * decides what to do with null (keep serving the last known-good load).
 */
export function loadSemanticIndex(dir: string, corpus: string): LoadedIndex | null {
  const manifest = readManifest(dir, corpus);
  if (!manifest) return null;

  let vectorsRaw: Buffer;
  try {
    vectorsRaw = readFileSync(path.join(dir, `${corpus}.vectors.f32`));
  } catch {
    return null;
  }
  const expectedLen = manifest.count * manifest.dim * 4 + BUILD_ID_TRAILER_BYTES;
  if (vectorsRaw.length !== expectedLen) return null;

  const trailer = vectorsRaw.subarray(vectorsRaw.length - BUILD_ID_TRAILER_BYTES).toString("ascii");
  if (trailer !== manifest.build_id) return null;

  // Float32Array requires a 4-byte-aligned underlying ArrayBuffer offset,
  // which an arbitrary Buffer#subarray is not guaranteed to have — copy into
  // a fresh, guaranteed-aligned buffer rather than viewing in place.
  const vectorBytes = vectorsRaw.subarray(0, vectorsRaw.length - BUILD_ID_TRAILER_BYTES);
  const aligned = Buffer.alloc(vectorBytes.length);
  vectorBytes.copy(aligned);
  const vectors = new Float32Array(aligned.buffer, aligned.byteOffset, aligned.length / 4);

  let metaRaw: string;
  try {
    metaRaw = readFileSync(path.join(dir, `${corpus}.meta.jsonl`), "utf8");
  } catch {
    return null;
  }
  const lines = metaRaw.split("\n").filter((l) => l.length > 0);
  if (lines.length !== manifest.count) return null;

  const meta: MetaLine[] = [];
  for (const line of lines) {
    let entry: MetaLine;
    try {
      entry = JSON.parse(line) as MetaLine;
    } catch {
      return null;
    }
    if (entry.build_id !== manifest.build_id) return null;
    meta.push(entry);
  }

  return {
    buildId: manifest.build_id,
    model: manifest.model,
    dim: manifest.dim,
    count: manifest.count,
    vectors,
    meta,
    builtAt: manifest.built_at,
  };
}

export type ScoredCandidate = { index: number; score: number; meta: MetaLine };

/**
 * Dot-product scoring. Cosine similarity reduces to a dot product because
 * every stored vector was L2-normalized at build time and the caller is
 * expected to have normalized `queryVector` the same way before calling
 * this — see deep-search.ts's semantic-recall stage.
 */
export function topK(index: LoadedIndex, queryVector: Float32Array, k: number): ScoredCandidate[] {
  if (queryVector.length !== index.dim) return [];
  const scored: ScoredCandidate[] = [];
  for (let i = 0; i < index.count; i++) {
    const base = i * index.dim;
    let dot = 0;
    for (let d = 0; d < index.dim; d++) {
      dot += queryVector[d] * index.vectors[base + d];
    }
    scored.push({ index: i, score: dot, meta: index.meta[i] });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// Keyed by "dir::corpus" — defensive against a future process ever serving
// more than one corpus (not the case today: one bot, one mounted corpus),
// flagged as a residual worth closing during round-3 adversarial review even
// though it could not affect any real deployment as currently configured.
const cachedIndexes = new Map<string, LoadedIndex | null>();

/**
 * The per-call reload gate (design section 5). Reads the small manifest.json
 * file on EVERY call — cheap enough to do unconditionally — and only pays
 * for a full reload (the more expensive vectors + metadata read/validate)
 * when its build_id differs from what is currently cached. Because the
 * build's atomic-rename order is vectors, then metadata, then manifest LAST,
 * observing a new build_id here means the other two files are already fully
 * in place, so a full reload triggered by that observation is always safe.
 *
 * On any failure (manifest unreadable this instant — e.g. mid-rename — or a
 * fresh load fails validation) this keeps serving whatever was last
 * successfully loaded, rather than going to null and losing the semantic
 * stage for a single missed read.
 */
export function getCurrentIndex(dir: string, corpus: string): LoadedIndex | null {
  const key = `${dir}::${corpus}`;
  const manifest = readManifest(dir, corpus);
  if (!manifest) return cachedIndexes.get(key) ?? null;

  const cached = cachedIndexes.get(key);
  if (cached === undefined || cached === null || manifest.build_id !== cached.buildId) {
    const fresh = loadSemanticIndex(dir, corpus);
    if (fresh !== null) {
      cachedIndexes.set(key, fresh);
      return fresh;
    }
    return cached ?? null;
  }
  return cached;
}
