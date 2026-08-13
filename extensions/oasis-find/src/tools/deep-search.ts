import fs from "node:fs";
import { globToRegExp, resolveInsideRoots, walkFiles, looksBinary, type SearchConfig } from "../search.js";

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

// Capped so one call cannot stall a turn. The cross-encoder is ~0.13s for 5
// passages warm, and scales with the pool, so this bounds it to a couple of
// seconds. Recall is still much wider than the returned limit.
const MAX_CHUNKS_TO_RANK = 60;
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

export type Passage = { path: string; line: number; text: string; hits: number };

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
    return { path: filePath, line: group[0], text, hits: group.length };
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

export interface DeepSearchConfig {
  search: SearchConfig;
}

export function createDeepSearchTool(config: DeepSearchConfig) {
  return {
    name: "deep_search",
    description:
      "Ask a QUESTION of your files and get back the passages that answer it, ranked by relevance. " +
      "USE THIS WHEN YOU DO NOT KNOW THE NAME OF THE THING — 'what already closes an option position', " +
      "'where is the deploy path defined', 'do we handle rate limits anywhere'. It finds capabilities you " +
      "cannot guess the identifier for, which is exactly what fs_grep cannot do. " +
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
      if (!pattern) {
        return json({
          error: "no searchable terms in that question — every word was a stopword",
          hint: "include a distinctive noun or verb, e.g. a subsystem or action name",
        });
      }
      if (args.subpath && !resolveInsideRoots(args.subpath, config.search.roots)) {
        return json({
          error: `subpath is outside your reach or does not exist: ${args.subpath}`,
          your_roots: config.search.roots,
        });
      }
      const limit = Math.max(1, Math.min(Number(args.limit) || 8, 20));
      const includeRe = args.include ? globToRegExp(args.include) : null;

      const walk = walkFiles(config.search, {
        subpath: args.subpath,
        accept: (_abs, basename) => (includeRe ? includeRe.test(basename) : true),
      });

      // Recall pass. Read each file ONCE and collect hit line numbers, rather
      // than reusing grepFiles — passages need the surrounding lines, which a
      // flat match list has already thrown away.
      const passages: Passage[] = [];
      let filesWithMatches = 0;
      let truncated = false;
      for (const file of walk.files) {
        if (passages.length >= MAX_CHUNKS_TO_RANK) {
          truncated = true;
          break;
        }
        if (file.bytes > config.search.maxFileBytes) continue;
        let buf: Buffer;
        try {
          buf = fs.readFileSync(file.path);
        } catch {
          continue;
        }
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
        passages.push(...buildPassages(lines, hits, file.path));
      }

      if (passages.length === 0) {
        return json({
          question,
          terms,
          files_scanned: walk.scanned,
          passages: [],
          hint: "no file contained any of those terms — try different wording, or fs_glob to confirm the files are in reach",
        });
      }

      const pool = passages.slice(0, MAX_CHUNKS_TO_RANK);
      const { order, error } = await rerank(question, pool);

      let ranked: { passage: Passage; score: number | null }[];
      let ranking: string;
      if (order.length > 0) {
        ranked = order.map((r) => ({ passage: pool[r.index], score: r.score })).filter((r) => r.passage);
        ranking = "cross-encoder (oasis-semantics bge-base)";
      } else {
        // Lexical fallback — more distinct hits first. Worse than the model,
        // and far better than returning nothing because a sidecar is down.
        ranked = [...pool].sort((a, b) => b.hits - a.hits).map((p) => ({ passage: p, score: null }));
        ranking = `lexical fallback (rerank unavailable: ${error ?? "unknown"})`;
      }

      return json({
        question,
        terms,
        ranking,
        files_scanned: walk.scanned,
        files_with_matches: filesWithMatches,
        passages_considered: pool.length,
        truncated_recall: truncated || undefined,
        // Absolute scores are low for code even when the order is right; the
        // model is trained on prose. Read the ORDER, not the number.
        passages: ranked.slice(0, limit).map((r) => ({
          path: r.passage.path,
          line: r.passage.line,
          score: r.score === null ? null : Number(r.score.toFixed(4)),
          text: r.passage.text,
        })),
      });
    },
  };
}
