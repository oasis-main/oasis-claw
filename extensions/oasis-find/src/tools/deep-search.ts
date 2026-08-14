import fs from "node:fs";
import { globToRegExp, resolveInsideRoots, walkFiles, looksBinary, safeReadFileSync, type SearchConfig } from "../search.js";
import { getCurrentIndex, topK, type LoadedIndex } from "../semantic-index.js";

/**
 * deep_search — ask a QUESTION of the filesystem and get the passages that
 * answer it, ordered by a cross-encoder.
 *
 * Why this exists (CLAW-090 / CLAW-092). The fleet had two search primitives
 * and a hole between them:
 *   * fs_grep is EXACT. You must already know the token. You cannot grep for a
 *     capability you cannot name — which is precisely the failure that made a
 *     bot rebuild an option-exit rail that already existed, because it never
 *     guessed the string `process_exit_fires`.
 *   * memory_search is SEMANTIC but MARKDOWN-ONLY (upstream schema.help.ts:1213
 *     — "extra directories or .md files"). Point it at a directory of .py or
 *     .ts and it indexes exactly nothing, so code is invisible to it.
 *
 * This closes that hole WITHOUT touching memory-core. It is deliberately not a
 * memory backend: registerMemoryRuntime is a single-occupancy slot that
 * memory-core already holds, so using it would mean REPLACING memory rather
 * than adding to it. registerTool is additive, so this sits beside fs_grep and
 * memory_search and can conflict with neither.
 *
 * Three stages:
 *   1. RECALL — lexical. Every content word in the question becomes an
 *      alternation branch, grepped over the live filesystem. Deliberately
 *      over-broad: this stage must not miss, precision is stage 3's job.
 *   2. CHUNK — a bare matched line is poor reranker input, so each hit is
 *      widened to its surrounding lines and adjacent hits merge into one
 *      passage. Prose context is what the cross-encoder actually scores.
 *   3. RERANK — the oasis-semantics cross-encoder scores each passage against
 *      the original question and returns the best.
 *
 * The scoring model (bge-reranker-base) is trained on natural-language
 * question/passage pairs. It ranks code correctly but scores it near zero in
 * absolute terms (measured: 0.0006 for a correct signature match, 0.2964 for
 * the same fact as a docstring). So treat the ORDER as the answer, not the
 * number, and expect higher scores from commented code and documentation.
 *
 * Degrades rather than fails: if the sidecar is unreachable the tool still
 * returns lexically-ranked results and says so in `ranking`.
 */

const SEMANTICS_URL = (process.env.OASIS_SEMANTICS_URL ?? "http://oasis-semantics:8732").replace(/\/+$/, "");
const RERANK_TIMEOUT_MS = 30_000;
const EMBED_TIMEOUT_MS = 30_000;

// CLAW-094: the single corpus scripts/build-semantic-index.py currently
// builds. Hardcoded rather than read from the manifest, because a bot's
// deep_search tool has exactly one mounted semantic-index directory today —
// promote this to a parameter if a second corpus (e.g. oasis-x) ever ships.
export const SEMANTIC_INDEX_CORPUS = "exp";

// Capped so one call cannot stall a turn. The cross-encoder is ~0.13s for 5
// passages warm, and scales with the pool, so this bounds it to a couple of
// seconds. Recall is still much wider than the returned limit.
const MAX_CHUNKS_TO_RANK = 60;
// Bounds the freshness top-up's live file re-reads (design section 5) to the
// same order of magnitude as lexical recall's own per-call file-read cost.
const MAX_STALE_TOPUPS = MAX_CHUNKS_TO_RANK;
const CONTEXT_LINES = 4;
// bge-base truncates the CONCATENATED query+passage at 512 tokens, so an
// over-long passage silently loses its tail. ~1200 chars keeps a passage
// comfortably inside that budget with the question attached.
const MAX_CHUNK_CHARS = 1200;

// Dropped from the lexical pattern: matching them would select every file in
// the tree and drown the reranker in noise. Question words go too — "how",
// "what", "where" carry the intent but appear in no useful source line.
const STOPWORDS = new Set(
  ("a an the and or of to in for with on at by from as is are be been being it its this that these those " +
    "i you we they he she do does did done have has had can could should would will shall may might must " +
    "how what where when why who which whom whose if then than there here not no yes my your our their " +
    "me us them him her about into over under again further once all any both each few more most other " +
    "some such only own same so too very just now get got make made use used using does doing")
    .split(" ")
    .filter(Boolean),
);

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** Content words from a natural-language question, longest first. */
export function queryTerms(question: string): string[] {
  const raw = (question.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter(
    (w) => !STOPWORDS.has(w),
  );
  // Longest first so the most specific term leads the alternation; also
  // deduplicated, since a repeated word adds cost and no recall.
  return [...new Set(raw)].sort((a, b) => b.length - a.length).slice(0, 12);
}

/**
 * Build the recall pattern. Terms are alternated, not ANDed: a passage that
 * answers the question rarely contains every word the operator used, and
 * requiring all of them is how a search returns nothing and looks broken.
 */
export function recallPattern(terms: string[]): RegExp | null {
  if (terms.length === 0) return null;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("|"), "i");
}

export type Passage = {
  path: string;
  line: number;
  text: string;
  hits: number;
  source: "lexical" | "semantic";
  staleReindexUsed?: boolean;
};

/**
 * Widen matched line numbers into passages, merging neighbours. Two hits four
 * lines apart belong to one passage, not two near-identical ones — the
 * reranker would otherwise spend its budget scoring the same code twice.
 */
export function buildPassages(lines: string[], hitLines: number[], filePath: string): Passage[] {
  if (hitLines.length === 0) return [];
  const sorted = [...hitLines].sort((a, b) => a - b);
  const groups: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = groups[groups.length - 1];
    if (sorted[i] - prev[prev.length - 1] <= CONTEXT_LINES * 2) prev.push(sorted[i]);
    else groups.push([sorted[i]]);
  }
  return groups.map((group) => {
    const start = Math.max(0, group[0] - 1 - CONTEXT_LINES);
    const end = Math.min(lines.length, group[group.length - 1] + CONTEXT_LINES);
    let text = lines.slice(start, end).join("\n").trim();
    if (text.length > MAX_CHUNK_CHARS) text = `${text.slice(0, MAX_CHUNK_CHARS)}…`;
    return { path: filePath, line: group[0], text, hits: group.length, source: "lexical" as const };
  });
}

async function rerank(
  question: string,
  passages: Passage[],
): Promise<{ order: { index: number; score: number }[]; error?: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RERANK_TIMEOUT_MS);
  try {
    const res = await fetch(`${SEMANTICS_URL}/v1/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: question, documents: passages.map((p) => p.text) }),
      signal: ac.signal,
    });
    if (!res.ok) return { order: [], error: `sidecar returned ${res.status}` };
    const data = (await res.json()) as { results?: { index: number; relevance_score: number }[] };
    if (!Array.isArray(data.results)) return { order: [], error: "sidecar returned no results array" };
    return { order: data.results.map((r) => ({ index: r.index, score: r.relevance_score })) };
  } catch (err) {
    return { order: [], error: String((err as Error)?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embed the query text via the shared oasis-semantics sidecar. This is the
 * ONLY thing sent over the network for stage 1.5's recall step — the caller's
 * own question, nothing else. See design section 6's "confirmation that no
 * network call can carry or leak another bot's content" — the sidecar has no
 * authentication and no per-caller state, and it never receives a file path,
 * a directory listing, or any per-bot identity; it only ever scores whatever
 * text this call includes in its own request body.
 */
async function embedQuery(question: string, model: string): Promise<Float32Array | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(`${SEMANTICS_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: question }),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { embeddings?: number[][] };
    const raw = data.embeddings?.[0];
    if (!raw || raw.length === 0) return null;
    return l2Normalize(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function l2Normalize(vec: number[]): Float32Array {
  let sumSq = 0;
  for (const x of vec) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  const out = new Float32Array(vec.length);
  if (norm === 0) return out;
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/**
 * Stage 1.5 — semantic recall (design section 6). Reads the bot's OWN
 * bind-mounted index file locally (getCurrentIndex/topK — no network for
 * this part), embeds the question over the network, and returns candidate
 * passages already translated to the bot's own container path convention
 * (baked in at build time — see semantic-index.ts / build-semantic-index.py).
 *
 * Freshness: for each candidate, compares its stored source_mtime_ns against
 * a live fs.statSync of the SAME path already inside this bot's own mounted
 * reach — no new authorization decision, since the bot could already read
 * that path directly. If the file changed, the stored TEXT is stale but the
 * LOCATION is still correct, so this re-reads the live file and rebuilds the
 * passage from the same line range rather than dropping it. Bounded to
 * MAX_STALE_TOPUPS extra small reads per call, the same order of magnitude
 * lexical recall already costs.
 */
async function semanticRecall(
  index: LoadedIndex,
  question: string,
  searchConfig: SearchConfig,
): Promise<Passage[]> {
  const queryVector = await embedQuery(question, index.model);
  if (queryVector === null) return [];

  const candidates = topK(index, queryVector, MAX_CHUNKS_TO_RANK);
  const passages: Passage[] = [];
  let toppedUp = 0;
  for (const c of candidates) {
    // Defensive re-check (design section 6). What this DOES protect: a query-
    // time bug in candidate selection returning something outside this bot's
    // CURRENTLY-live roots (e.g. a role.yaml narrowing that has not yet
    // reached a rebuild). What it does NOT protect: a build-time mistake that
    // already wrote unauthorized content into this bot's OWN meta.jsonl file
    // — that file was delivered wholesale by the bind mount, and anything
    // with ordinary read access inside this container can already read it
    // directly, independent of this tool's own code path. The build's own
    // required self-test (nested-shield exclusion) and the scheduled drift
    // check are what bound THAT risk; this check is not a substitute for them.
    if (!resolveInsideRoots(c.meta.path, searchConfig.roots)) continue;

    let text = c.meta.text;
    let stale = false;
    if (toppedUp < MAX_STALE_TOPUPS) {
      try {
        const st = fs.statSync(c.meta.path);
        const liveMtimeNs = Math.round(st.mtimeMs * 1_000_000);
        if (liveMtimeNs > c.meta.source_mtime_ns) {
          const buf = safeReadFileSync(c.meta.path);
          if (buf === null) continue; // race/removed since the stat -> skip, never trust
          const lines = buf.toString("utf8").split("\n");
          const start = Math.max(0, c.meta.line_start - 1);
          const end = Math.min(lines.length, c.meta.line_end);
          text = lines.slice(start, end).join("\n");
          stale = true;
          toppedUp += 1;
        }
      } catch {
        continue; // file no longer exists -> drop the chunk silently (design section 5)
      }
    }

    passages.push({
      path: c.meta.path,
      line: c.meta.line_start,
      text,
      hits: 0,
      source: "semantic",
      staleReindexUsed: stale || undefined,
    });
  }
  return passages;
}

/**
 * Merge lexical and semantic passages, deduplicated by (path, line) — the
 * same passage found by both stages is kept once, as lexical (arbitrary but
 * deterministic; the two stages rarely disagree on the text for an identical
 * path+line). Truncation to `cap` is INTERLEAVED, not a plain slice: a plain
 * slice after lexical-then-semantic concatenation would let a lexical pool
 * that alone fills `cap` crowd out every semantic candidate before the
 * reranker ever sees one — defeating the reason semantic recall exists.
 */
export function mergeAndDedupe(lexical: Passage[], semantic: Passage[], cap: number): Passage[] {
  const seen = new Set<string>();
  const dedupedLexical: Passage[] = [];
  const dedupedSemantic: Passage[] = [];
  for (const p of lexical) {
    const key = `${p.path}::${p.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedLexical.push(p);
  }
  for (const p of semantic) {
    const key = `${p.path}::${p.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedSemantic.push(p);
  }
  const merged: Passage[] = [];
  let i = 0;
  let j = 0;
  while (merged.length < cap && (i < dedupedLexical.length || j < dedupedSemantic.length)) {
    if (i < dedupedLexical.length) merged.push(dedupedLexical[i++]);
    if (merged.length >= cap) break;
    if (j < dedupedSemantic.length) merged.push(dedupedSemantic[j++]);
  }
  return merged;
}

export interface DeepSearchConfig {
  search: SearchConfig;
  /** Absolute container-path directory a bind mount delivered this bot's own
   * pre-built semantic index into (design section 3's /reach/semantic-index).
   * Undefined disables stage 1.5 entirely — deep_search then runs exactly as
   * it did before CLAW-094, lexical-recall-and-rerank only. */
  semanticIndexDir?: string;
}

export function createDeepSearchTool(config: DeepSearchConfig) {
  return {
    name: "deep_search",
    description:
      "Ask a QUESTION of your files and get back the passages that answer it, ranked by relevance. " +
      "USE THIS WHEN YOU DO NOT KNOW THE NAME OF THE THING — 'what already closes an option position', " +
      "'where is the deploy path defined', 'do we handle rate limits anywhere'. It finds capabilities you " +
      "cannot guess the identifier for, which is exactly what fs_grep cannot do. " +
      "Where available, this combines LEXICAL recall (exact word matches) with true SEMANTIC recall (vector " +
      "similarity over a pre-built index of your own reach) before reranking — semantic recall can surface a " +
      "passage that shares NO vocabulary with your question, which lexical recall alone would miss entirely. " +
      "Each returned passage is tagged source:'lexical'|'semantic' so you can tell which found it. " +
      "Prefer fs_grep when you DO know the exact string (a ticket id, a function name, an error message) — " +
      "it is faster and exact. Prefer memory_search for your own notes and prior conversations; note that " +
      "memory_search only covers indexed markdown, while this searches every file you can reach, including code. " +
      "Returns path, line number and the passage, best first. Narrow with `include`/`subpath` for speed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        question: {
          type: "string",
          description:
            "A natural-language question, not a regex. e.g. 'how do we automatically close an option position'. " +
            "Write it as you would ask a colleague — the words you choose are the recall terms.",
        },
        include: {
          type: "string",
          description: "Optional file-NAME glob to restrict the search, e.g. '*.py', '*.ts', '*.md'.",
        },
        subpath: {
          type: "string",
          description: "Optional absolute directory to search under. Must be inside your reach.",
        },
        limit: {
          type: "number",
          description: "Maximum passages to return (default 8, hard cap 20).",
        },
      },
    },
    async execute(
      _toolCallId: string,
      args: { question: string; include?: string; subpath?: string; limit?: number },
    ) {
      const question = String(args.question ?? "").trim();
      if (!question) {
        return json({ error: "question is required, e.g. \"how do we close an option position\"" });
      }
      const terms = queryTerms(question);
      const pattern = recallPattern(terms);
      // NOTE (CLAW-094): a `!pattern` question (entirely stopwords, e.g. "how
      // do we do it") used to hard-error here, which — before semantic recall
      // existed — meant NO recall was possible at all. It still means lexical
      // recall cannot run (there is no term to grep for), but semantic
      // recall needs no terms, only the raw question text, so it is NOT
      // skipped below merely because `pattern` is null.
      if (args.subpath && !resolveInsideRoots(args.subpath, config.search.roots)) {
        return json({
          error: `subpath is outside your reach or does not exist: ${args.subpath}`,
          your_roots: config.search.roots,
        });
      }
      const limit = Math.max(1, Math.min(Number(args.limit) || 8, 20));
      const includeRe = args.include ? globToRegExp(args.include) : null;

      // ── Stage 1: lexical recall (existing, unchanged in mechanism) ──────
      let lexicalPassages: Passage[] = [];
      let filesScanned = 0;
      let filesWithMatches = 0;
      let truncated = false;
      if (pattern) {
        const walk = walkFiles(config.search, {
          subpath: args.subpath,
          accept: (_abs, basename) => (includeRe ? includeRe.test(basename) : true),
        });
        filesScanned = walk.scanned;
        // Read each file ONCE and collect hit line numbers, rather than
        // reusing grepFiles — passages need the surrounding lines, which a
        // flat match list has already thrown away.
        for (const file of walk.files) {
          if (lexicalPassages.length >= MAX_CHUNKS_TO_RANK) {
            truncated = true;
            break;
          }
          if (file.bytes > config.search.maxFileBytes) continue;
          // safeReadFileSync (CLAW-094): O_NOFOLLOW + fstat/lstat inode check —
          // walkFiles' scan-time symlink check alone leaves a TOCTOU window a
          // write-capable bot could race. See search.ts's doc comment.
          const buf = safeReadFileSync(file.path);
          if (buf === null) continue;
          if (looksBinary(buf)) continue;
          const lines = buf.toString("utf8").split("\n");
          const hits: number[] = [];
          for (let i = 0; i < lines.length; i += 1) {
            pattern.lastIndex = 0;
            if (pattern.test(lines[i])) hits.push(i + 1);
            if (hits.length >= config.search.maxMatchesPerFile) break;
          }
          if (hits.length === 0) continue;
          filesWithMatches += 1;
          lexicalPassages.push(...buildPassages(lines, hits, file.path));
        }
      }

      // ── Stage 1.5: semantic recall (new, CLAW-094) ───────────────────────
      let semanticPassages: Passage[] = [];
      let semanticIndexAgeHours: number | undefined;
      if (config.semanticIndexDir) {
        const index = getCurrentIndex(config.semanticIndexDir, SEMANTIC_INDEX_CORPUS);
        if (index) {
          semanticIndexAgeHours = (Date.now() - new Date(index.builtAt).getTime()) / 3_600_000;
          let raw = await semanticRecall(index, question, config.search);
          if (args.subpath) raw = raw.filter((p) => p.path.startsWith(args.subpath as string));
          if (includeRe) raw = raw.filter((p) => includeRe.test(p.path.split("/").pop() ?? ""));
          semanticPassages = raw;
        }
      }

      const pool = mergeAndDedupe(lexicalPassages, semanticPassages, MAX_CHUNKS_TO_RANK);

      if (pool.length === 0) {
        return json({
          question,
          terms,
          files_scanned: filesScanned,
          semantic_index_age_hours: semanticIndexAgeHours === undefined ? undefined : Number(semanticIndexAgeHours.toFixed(1)),
          passages: [],
          hint: pattern
            ? "no file contained any of those terms and semantic recall found nothing close enough — try different wording, or fs_glob to confirm the files are in reach"
            : "every word in that question was a stopword, and semantic recall found nothing — include a distinctive noun or verb, e.g. a subsystem or action name",
        });
      }

      const { order, error } = await rerank(question, pool);

      let ranked: { passage: Passage; score: number | null }[];
      let ranking: string;
      if (order.length > 0) {
        ranked = order.map((r) => ({ passage: pool[r.index], score: r.score })).filter((r) => r.passage);
        ranking = semanticPassages.length > 0
          ? "cross-encoder (oasis-semantics bge-base) over lexical + semantic candidates"
          : "cross-encoder (oasis-semantics bge-base)";
      } else {
        // Lexical fallback — more distinct hits first. Worse than the model,
        // and far better than returning nothing because a sidecar is down.
        // Semantic candidates carry hits:0, so they sort after any lexical
        // hit but are still returned rather than dropped.
        ranked = [...pool].sort((a, b) => b.hits - a.hits).map((p) => ({ passage: p, score: null }));
        ranking = `lexical fallback (rerank unavailable: ${error ?? "unknown"})`;
      }

      return json({
        question,
        terms,
        ranking,
        files_scanned: filesScanned,
        files_with_matches: filesWithMatches,
        passages_considered: pool.length,
        truncated_recall: truncated || undefined,
        semantic_index_age_hours: semanticIndexAgeHours === undefined ? undefined : Number(semanticIndexAgeHours.toFixed(1)),
        // Absolute scores are low for code even when the order is right; the
        // model is trained on prose. Read the ORDER, not the number.
        passages: ranked.slice(0, limit).map((r) => ({
          path: r.passage.path,
          line: r.passage.line,
          score: r.score === null ? null : Number(r.score.toFixed(4)),
          text: r.passage.text,
          source: r.passage.source,
          stale_reindex_used: r.passage.staleReindexUsed || undefined,
        })),
      });
    },
  };
}
