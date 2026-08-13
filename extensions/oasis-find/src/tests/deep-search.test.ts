import { describe, expect, it } from "vitest";
import { buildPassages, queryTerms, recallPattern } from "../tools/deep-search.js";

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
