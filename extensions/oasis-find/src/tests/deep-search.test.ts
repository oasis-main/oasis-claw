import { describe, expect, it } from "vitest";
import { buildPassages, mergeAndDedupe, queryTerms, recallPattern, type Passage } from "../tools/deep-search.js";

function passage(path: string, line: number, source: "lexical" | "semantic"): Passage {
  return { path, line, text: `${source} text for ${path}:${line}`, hits: source === "lexical" ? 1 : 0, source };
}

// The recall stage decides what the reranker can possibly see. A term dropped
// here is a passage that can never be returned, however good the model is —
// so these tests pin the tokenizer's behaviour rather than its implementation.
describe("queryTerms", () => {
  it("keeps content words and drops stopwords and question words", () => {
    const terms = queryTerms("how do we automatically close an option position");
    expect(terms).toContain("automatically");
    expect(terms).toContain("position");
    expect(terms).toContain("option");
    expect(terms).toContain("close");
    for (const stop of ["how", "do", "we", "an"]) {
      expect(terms, `stopword ${stop} must not survive`).not.toContain(stop);
    }
  });

  it("orders longest-first so the most specific term leads", () => {
    const terms = queryTerms("deploy the sentinel reconciliation");
    expect(terms[0]).toBe("reconciliation");
  });

  it("deduplicates repeated words", () => {
    const terms = queryTerms("order order order placement");
    expect(terms.filter((t) => t === "order")).toHaveLength(1);
  });

  it("keeps identifier-shaped tokens, which are often the real answer", () => {
    expect(queryTerms("where is process_exit_fires called")).toContain("process_exit_fires");
  });

  it("returns nothing when the question is entirely stopwords", () => {
    expect(queryTerms("how do we do it")).toEqual([]);
    expect(recallPattern([])).toBeNull();
  });
});

describe("recallPattern", () => {
  it("ORs the terms — a passage need not contain every word", () => {
    const re = recallPattern(["option", "close"])!;
    expect(re.test("def close_position(book):")).toBe(true);
    expect(re.test("an option chain")).toBe(true);
    expect(re.test("unrelated line")).toBe(false);
  });

  it("escapes regex metacharacters so a term cannot corrupt the pattern", () => {
    // Without escaping this throws or silently matches everything.
    const re = recallPattern(["c++", "a.b"])!;
    expect(re.test("value of c++ here")).toBe(true);
    expect(re.test("axb")).toBe(false); // '.' must be literal, not any-char
  });
});

describe("buildPassages", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);

  it("widens a hit into surrounding context", () => {
    const [p] = buildPassages(lines, [20], "/reach/x.py");
    expect(p.path).toBe("/reach/x.py");
    expect(p.line).toBe(20);
    expect(p.text).toContain("line 16");
    expect(p.text).toContain("line 24");
    expect(p.text).not.toContain("line 15");
  });

  it("merges nearby hits into ONE passage instead of near-duplicates", () => {
    // Two hits 3 lines apart share context; scoring both would waste the
    // reranker's budget on the same code.
    const passages = buildPassages(lines, [20, 23], "/reach/x.py");
    expect(passages).toHaveLength(1);
    expect(passages[0].hits).toBe(2);
  });

  it("keeps distant hits as separate passages", () => {
    const passages = buildPassages(lines, [5, 35], "/reach/x.py");
    expect(passages).toHaveLength(2);
    expect(passages.map((p) => p.line)).toEqual([5, 35]);
  });

  it("clamps context at the file edges", () => {
    expect(() => buildPassages(lines, [1, 40], "/reach/x.py")).not.toThrow();
    const [first] = buildPassages(lines, [1], "/reach/x.py");
    expect(first.text).toContain("line 1");
  });

  it("returns nothing when there are no hits", () => {
    expect(buildPassages(lines, [], "/reach/x.py")).toEqual([]);
  });

  it("truncates an oversized passage so it cannot blow the 512-token budget", () => {
    // 9 context lines get joined, so each must be long enough that the JOINED
    // passage clears 1200 chars — at 120 chars/line it lands at 1088 and is
    // (correctly) left untruncated.
    const fat = Array.from({ length: 200 }, () => "x".repeat(300));
    const [p] = buildPassages(fat, [100], "/reach/big.py");
    expect(p.text.length).toBeLessThanOrEqual(1201); // 1200 + the ellipsis
    expect(p.text.endsWith("…")).toBe(true);
  });
});

// CLAW-094: merging lexical and semantic candidates before rerank. The
// interleaving matters — a plain concat-then-slice would let a full lexical
// pool crowd out every semantic candidate before the reranker ever saw one,
// which is exactly the failure mode semantic recall exists to fix.
describe("mergeAndDedupe", () => {
  it("keeps both sources when combined size is under the cap", () => {
    const lex = [passage("/reach/a.py", 1, "lexical")];
    const sem = [passage("/reach/b.py", 1, "semantic")];
    const merged = mergeAndDedupe(lex, sem, 10);
    expect(merged).toHaveLength(2);
    expect(merged.map((p) => p.source).sort()).toEqual(["lexical", "semantic"]);
  });

  it("dedupes an identical (path, line) hit from both sources, keeping lexical", () => {
    const lex = [passage("/reach/a.py", 10, "lexical")];
    const sem = [passage("/reach/a.py", 10, "semantic")];
    const merged = mergeAndDedupe(lex, sem, 10);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe("lexical");
  });

  it("dedupes within a single source too (defensive, not just cross-source)", () => {
    const lex = [passage("/reach/a.py", 5, "lexical"), passage("/reach/a.py", 5, "lexical")];
    const merged = mergeAndDedupe(lex, [], 10);
    expect(merged).toHaveLength(1);
  });

  it("interleaves rather than letting a full lexical pool crowd out every semantic candidate", () => {
    const lex = Array.from({ length: 60 }, (_, i) => passage(`/reach/lex${i}.py`, 1, "lexical"));
    const sem = Array.from({ length: 60 }, (_, i) => passage(`/reach/sem${i}.py`, 1, "semantic"));
    const merged = mergeAndDedupe(lex, sem, 10);
    expect(merged).toHaveLength(10);
    const semanticCount = merged.filter((p) => p.source === "semantic").length;
    expect(semanticCount).toBeGreaterThan(0);
    expect(semanticCount).toBeGreaterThanOrEqual(4); // roughly half, not zero
  });

  it("does not overrun the cap even when one source is empty", () => {
    const lex = Array.from({ length: 20 }, (_, i) => passage(`/reach/lex${i}.py`, 1, "lexical"));
    const merged = mergeAndDedupe(lex, [], 5);
    expect(merged).toHaveLength(5);
  });

  it("returns everything when both sources combined are still under the cap, no gaps", () => {
    const lex = [passage("/reach/a.py", 1, "lexical"), passage("/reach/b.py", 1, "lexical")];
    const sem = [passage("/reach/c.py", 1, "semantic")];
    const merged = mergeAndDedupe(lex, sem, 100);
    expect(merged).toHaveLength(3);
  });
});
