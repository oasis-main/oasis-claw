#!/usr/bin/env node
// ── claw-ste-lint: approximate ASD-STE100 checks for fleet reports ──────────
// Mike reads every fleet report in ASD-STE100 Simplified Technical English.
// Yes Man runs this on a draft report, rewrites each flagged line, and runs it
// once more. The checks are approximate on purpose (no grammar model):
//   - a sentence longer than 25 words
//   - a possible passive verb ("is/was/were/been ... -ed" and common irregulars)
//   - a sentence that starts with "It" or "This"/"These" with no noun after it
// Front matter, fenced code, table rows and headings are not checked.
//
// Usage: node scripts/claw-ste-lint.mjs <file.md>   (exit 0; prints findings)

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MAX_WORDS = 25;
const IRREGULAR = "done|made|sent|written|given|taken|seen|shown|built|set|run|found|kept|left|held|known|put|read|told|paid|lost|cut|split|chosen|drawn|broken|frozen|spoken|stolen|thrown|begun|gone";
const PASSIVE = new RegExp(`\\b(?:is|are|was|were|be|been|being)\\s+(?:not\\s+|also\\s+|now\\s+|still\\s+)?(?:\\w+ed|${IRREGULAR})\\b`, "i");
// "This"/"These" followed by a verb, not a noun ("This is", "This means").
const BARE_THIS = /^(?:this|these|that)\s+(?:is|are|was|were|means|shows|makes|gives|has|have|will|can|does|did)\b/i;

/** Words in a sentence; inline code and URLs count as one word each. */
export function words(s) {
  return String(s).replace(/`[^`]*`/g, "CODE").replace(/https?:\/\/\S+/g, "URL").split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
}

/** Split a line into sentences at ". ", "? ", "! " (not inside inline code). */
export function sentences(line) {
  const masked = line.replace(/`[^`]*`/g, (m) => m.replace(/[.?!]/g, "\u0000"));
  return masked
    .split(/(?<=[.?!])\s+(?=[A-Z0-9"(])/)
    .map((s) => s.replace(/\u0000/g, ".").trim())
    .filter(Boolean);
}

export function lint(text) {
  const out = [];
  let inFence = false;
  let inFront = false;
  String(text).split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (i === 0 && line === "---") {
      inFront = true;
      return;
    }
    if (inFront) {
      if (line === "---") inFront = false;
      return;
    }
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence || !line || line.startsWith("#") || line.startsWith("|") || line === "END OF REPORT") return;
    const body = line.replace(/^(?:[-*]|\d+\.)\s+/, "").replace(/^\*\*[^*]+\*\*:?\s*/, "");
    for (const s of sentences(body)) {
      const n = words(s).length;
      if (n > MAX_WORDS) out.push({ line: i + 1, rule: "long", detail: `${n} words`, text: s });
      if (PASSIVE.test(s.replace(/`[^`]*`/g, ""))) out.push({ line: i + 1, rule: "passive", detail: "possible passive verb", text: s });
      if (/^It\b/.test(s) || BARE_THIS.test(s)) out.push({ line: i + 1, rule: "pronoun", detail: "starts with a pronoun; name the noun", text: s });
    }
  });
  return out;
}

function main(argv) {
  const file = argv[0];
  if (!file) {
    process.stderr.write("usage: claw-ste-lint.mjs <file.md>\n");
    process.exit(2);
  }
  const found = lint(readFileSync(file, "utf8"));
  for (const f of found) process.stdout.write(`${file}:${f.line}: [${f.rule}] ${f.detail}: ${f.text.slice(0, 160)}\n`);
  process.stdout.write(`${found.length} findings (${["long", "passive", "pronoun"].map((r) => `${r} ${found.filter((f) => f.rule === r).length}`).join(", ")})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
