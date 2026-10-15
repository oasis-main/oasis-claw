// CLAW-124: the fleet snapshot parses each bot's STATUS.md (PLAYBOOK section 3).
import assert from "node:assert/strict";
import { test } from "node:test";
import { markStale, nyDate, parseStatus, redact } from "../claw-fleet-snapshot.mjs";

// Built from parts so the public push guard does not read a token-shaped literal.
const FAKE_TOKEN = ["gh", "p_", "abcdefghijklmnopqrstuvwxyz0123"].join("");

const STATUS = `# alpha — status

STATUS: KIN-218 half done
SINCE LAST: parser at src/p.py
NEXT: finish the parser by Fri
NEEDS FROM MIKE: Approve the prod merge
NEEDS FROM MIKE: none
BLOCKERS: none

## OPEN
- KIN-218 | next: finish the parser | directive: DIR-0001
- KIN-215 | next: wait for data | directive: none
not a list line
- token ${FAKE_TOKEN} leak | next: x
`;

test("parseStatus: fields, NEEDS lines ('none' dropped), OPEN items with a checked directive id", () => {
  const p = parseStatus(STATUS);
  assert.equal(p.status, "KIN-218 half done");
  assert.equal(p.next, "finish the parser by Fri");
  assert.deepEqual(p.needs, ["Approve the prod merge"]);
  assert.equal(p.blockers, null);
  assert.deepEqual(p.open.slice(0, 2), [
    { item: "KIN-218", next: "finish the parser", directive: "DIR-0001" },
    { item: "KIN-215", next: "wait for data", directive: null },
  ]);
  assert.equal(p.open.length, 3);
});

test("NEGATIVE CONTROL: a key-shaped string in an OPEN line is redacted", () => {
  const p = parseStatus(STATUS);
  assert.doesNotMatch(JSON.stringify(p), /ghp_/);
  assert.match(p.open[2].item, /\[redacted\]/);
  assert.equal(redact(FAKE_TOKEN), "[redacted]");
});

test("markStale: the same next step on 2 New York days is stale; a changed next step resets it", () => {
  const h = {};
  const day = (d, open) => markStale("alpha", open.map((o) => ({ ...o })), h, d);
  day("2026-10-13", [{ item: "A", next: "x" }, { item: "B", next: "y" }]);
  day("2026-10-14", [{ item: "A", next: "x" }, { item: "B", next: "y2" }]);
  const out = day("2026-10-15", [{ item: "A", next: "x" }, { item: "B", next: "y2" }]);
  assert.deepEqual(out.map((o) => [o.item, o.stale, o.since]), [["A", true, "2026-10-13"], ["B", false, "2026-10-13"]]);
  assert.deepEqual(Object.keys(h.alpha), ["A", "B"]);
  day("2026-10-16", [{ item: "B", next: "y2" }]);
  assert.deepEqual(Object.keys(h.alpha), ["B"], "a closed item leaves the history");
});

test("nyDate uses New York days", () => {
  assert.equal(nyDate(Date.parse("2026-10-16T02:00:00Z")), "2026-10-15");
  assert.equal(nyDate(Date.parse("2026-10-16T05:00:00Z")), "2026-10-16");
});
