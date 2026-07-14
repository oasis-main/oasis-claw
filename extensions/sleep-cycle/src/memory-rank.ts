/**
 * Vector-ranked memory hits for the waking summary.
 *
 * Reads workspace/MEMORY.md + workspace/memory/*.md, chunks them by heading /
 * bullet, embeds query + chunks through the oasis-semantics sidecar
 * (POST /api/embed — same endpoint + payload the oasis-semantics extension's
 * embedding-client uses), and returns the top-K by cosine similarity.
 *
 * Runs ONCE per nightly cycle (not per prompt) and the result is cached in
 * the cycle state — zero LLM tokens, one embedding burst per night.
 * `semanticsModel` must match the memory-core embedding tier ("default" =
 * bge-small-en-v1.5) so scores stay comparable with memory_search behavior.
 */

import fs from "node:fs";
import path from "node:path";
import type { MemoryHit } from "./mutex.js";

export type MemoryChunk = { source: string; title: string; text: string };

const MAX_CHUNKS = 120;
const MAX_CHUNK_CHARS = 800;
const EMBED_TIMEOUT_MS = 30_000;

/** Split a markdown document into heading-or-bullet chunks. Pure. */
export function chunkMarkdown(source: string, text: string, cap = MAX_CHUNKS): MemoryChunk[] {
  const chunks: MemoryChunk[] = [];
  let currentTitle = path.basename(source);
  let buf: string[] = [];

  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) {
      chunks.push({ source, title: currentTitle, text: body.slice(0, MAX_CHUNK_CHARS) });
    }
    buf = [];
  };

  for (const line of text.split("\n")) {
    if (/^#{1,4}\s/.test(line)) {
      flush();
      currentTitle = line.replace(/^#+\s*/, "").trim() || currentTitle;
    } else if (/^- \[/.test(line) || /^- \*\*/.test(line)) {
      // Index-style bullet (MEMORY.md convention) — each bullet is a chunk.
      flush();
      chunks.push({
        source,
        title: line.replace(/^- /, "").slice(0, 80),
        text: line.slice(0, MAX_CHUNK_CHARS),
      });
      continue;
    } else {
      buf.push(line);
    }
    if (chunks.length >= cap) {
      break;
    }
  }
  flush();
  return chunks.slice(0, cap);
}

/** Collect chunks from the workspace memory surfaces. */
export function collectMemoryChunks(workspaceDir: string): MemoryChunk[] {
  const chunks: MemoryChunk[] = [];
  const candidates: string[] = [path.join(workspaceDir, "MEMORY.md")];
  const memDir = path.join(workspaceDir, "memory");
  try {
    for (const entry of fs.readdirSync(memDir)) {
      if (entry.endsWith(".md")) {
        candidates.push(path.join(memDir, entry));
      }
    }
  } catch {
    // no memory/ dir — MEMORY.md alone is fine
  }
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, "utf-8");
      chunks.push(...chunkMarkdown(file, text, MAX_CHUNKS - chunks.length));
    } catch {
      // unreadable file — skip
    }
    if (chunks.length >= MAX_CHUNKS) {
      break;
    }
  }
  return chunks;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Embed query + chunks via oasis-semantics and return topK hits.
 * Best-effort: returns [] on sidecar failure (waking summary degrades to
 * handoff + transcript pointers, never blocks the cycle).
 */
export async function rankMemoryHits(params: {
  endpoint: string;
  model: string;
  query: string;
  chunks: MemoryChunk[];
  topK: number;
  fetchImpl?: typeof fetch;
}): Promise<MemoryHit[]> {
  const { endpoint, model, query, chunks, topK } = params;
  if (!query.trim() || chunks.length === 0 || topK <= 0) {
    return [];
  }
  const doFetch = params.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await doFetch(`${endpoint.replace(/\/+$/, "")}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: [query, ...chunks.map((c) => c.text)] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as { embeddings?: number[][] };
    const embeddings = data.embeddings;
    if (!embeddings || embeddings.length !== chunks.length + 1) {
      return [];
    }
    const [queryVec, ...chunkVecs] = embeddings;
    return chunks
      .map((c, i) => ({
        source: c.source,
        title: c.title,
        snippet: c.text.slice(0, 240),
        score: cosine(queryVec, chunkVecs[i]),
      }))
      .sort((x, y) => y.score - x.score)
      .slice(0, topK);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
