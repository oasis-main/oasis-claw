import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { redactBlock, restarts, windowStart } from "../claw-fleet-report-inputs.mjs";
import { lint, sentences } from "../claw-ste-lint.mjs";

let dirs = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("claw-fleet-report-inputs", () => {
  it("starts the window at the newest earlier report, or 7 days back", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-inputs-"));
    dirs.push(dir);
    const now = Date.parse("2026-11-04T12:00:00Z");
    assert.equal(windowStart(dir, "2026-11-04", now).from, null);
    assert.equal(windowStart(dir, "2026-11-04", now).since, now - 7 * 24 * 3600 * 1000);
    for (const n of ["STATUS-REPORT-2026-11-02.md", "REPORT-2026-10-30.md", "REPORT-2026-11-04.md", "REPORT-INPUTS-2026-11-03.md"]) writeFileSync(join(dir, n), "x");
    const w = windowStart(dir, "2026-11-04", now);
    assert.equal(w.from, "2026-11-02");
    assert.equal(w.since, Date.parse("2026-11-02T12:00:00Z"));
  });

  it("counts watchdog restarts per bot in the window, with container names mapped", () => {
    const log = [
      "2026-10-30T08:00:00-04:00 [watchdog] oasis-claw-runtime: restart issued",
      "2026-10-31T08:00:00-04:00 [watchdog] oasis-claw-hello-world: restart issued",
      "2026-10-31T09:00:00-04:00 [watchdog] oasis-claw-house: restart issued",
      "2026-10-31T09:00:00-04:00 [watchdog] oasis-claw-house: channel healthy",
      "2026-10-20T09:00:00-04:00 [watchdog] oasis-claw-house: restart issued",
    ].join("\n");
    assert.deepEqual(restarts(log, Date.parse("2026-10-26T00:00:00Z")), { nimbus: 1, helloworld: 1, house: 1 });
  });

  it("keeps lines and redacts key-shaped strings in multi-line text", () => {
    const out = redactBlock("## OPEN\n- item one\ntoken 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA end", 1000);
    assert.equal(out.split("\n").length, 3);
    assert.match(out, /\[redacted\]/);
    assert.doesNotMatch(out, /AAAAAAAA/);
  });
});

describe("claw-ste-lint", () => {
  it("flags a long sentence, a passive verb and a sentence that starts with It", () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ") + ".";
    const found = lint(["# Title", long, "The PR was merged by Mike.", "It failed twice.", "The test failed."].join("\n"));
    assert.deepEqual(found.map((f) => [f.line, f.rule]), [[2, "long"], [3, "passive"], [4, "pronoun"]]);
  });

  it("NEGATIVE CONTROL: front matter, code fences, tables and headings are not checked", () => {
    const text = ["---", "type: it was written", "---", "```", "It was done by a script that is long enough to pass the limit of words here for sure yes.", "```", "| It was done | x |", "## It was done"].join("\n");
    assert.deepEqual(lint(text), []);
  });

  it("splits sentences but not inside inline code", () => {
    assert.deepEqual(sentences("Run `a.b.c`. Then stop."), ["Run `a.b.c`.", "Then stop."]);
  });
});
