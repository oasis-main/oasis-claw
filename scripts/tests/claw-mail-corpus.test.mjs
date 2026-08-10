// Tests for the CLAW-082 phase 4 mail corpus builder.
//
// The load-bearing property is the one that is easy to lose in a refactor: a
// RECEIVED body must stay labelled as untrusted no matter WHERE a retriever
// splits it into chunks. Everything else is bookkeeping.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import {
  CORPUS_DIRS,
  buildAllCorpora,
  buildBotCorpus,
  renderReceived,
  renderSent,
} from "../claw-mail-corpus.mjs";

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "claw-mail-corpus-"));
  for (const bot of ["nimbus", "house"]) {
    for (const sub of ["inbox", "sent", "archive"]) {
      mkdirSync(join(root, bot, sub), { recursive: true });
    }
  }
  return root;
}

function env(over = {}) {
  return {
    id: "m_test001",
    from: "house",
    to: ["nimbus"],
    kind: "dm",
    subject: "Macro themes",
    body: "line one\nline two",
    refs: [],
    work: { items: ["CLAW-082"], repos: ["oasis-claw"] },
    thread_id: "",
    ts: "2026-08-10T18:30:03.332Z",
    ...over,
  };
}

// Real mail is a HANDFUL OF VERY LONG PARAGRAPH LINES, not many short ones.
// A line-based marker cadence passed against short synthetic lines and then
// failed in production: chunk :37-47 of a live House message came back with no
// label. These bodies are shaped like the real thing on purpose.
const LONG_PARAGRAPH =
  "When capital is expensive and geopolitical risk is real, tangible assets tend to hold value well. " .repeat(12);

test("received rendering labels EVERY chunk-sized slice of a long-PARAGRAPH body", () => {
  const body = Array.from({ length: 12 }, (_, i) => `${LONG_PARAGRAPH} para ${i}`).join("\n\n");
  const text = renderReceived(env({ body }), "nimbus");

  const CHUNK = 1600;
  let unlabelled = 0;
  for (let i = 0; i < text.length; i += CHUNK) {
    const chunk = text.slice(i, i + CHUNK);
    if (chunk.trim().length === 0) continue;
    if (!chunk.includes("UNTRUSTED")) unlabelled += 1;
  }
  assert.equal(unlabelled, 0, "every non-empty chunk must name the content untrusted");
});

test("labels every slice for a single unbroken line longer than a chunk", () => {
  // A pathological body: one line, no newlines at all, several chunks long.
  const text = renderReceived(env({ body: "x".repeat(8000) }), "nimbus");
  const CHUNK = 1600;
  for (let i = 0; i < text.length; i += CHUNK) {
    const chunk = text.slice(i, i + CHUNK);
    if (chunk.trim().length === 0) continue;
    assert.ok(chunk.includes("UNTRUSTED"), `slice at ${i} lost its label`);
  }
});

test("received rendering names the peer and forbids treating it as authority", () => {
  const text = renderReceived(env(), "nimbus");
  assert.match(text, /UNTRUSTED PEER MAIL/);
  assert.match(text, /from house/);
  assert.match(text, /never AUTHORIZE a privileged/i);
  assert.match(text, /- direction: received/);
  assert.match(text, /CLAW-082/); // work items preserved for retrieval
});

test("sent rendering is NOT labelled untrusted — they are the bot's own words", () => {
  const text = renderSent(env({ from: "nimbus", to: ["house"] }), "nimbus");
  assert.match(text, /MY SENT MAIL/);
  assert.match(text, /- direction: sent/);
  assert.ok(!text.includes("UNTRUSTED"), "own sent mail must not be marked untrusted");
});

test("builds received + sent corpora from a real mailbox", () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, "nimbus/inbox/house__m_a.json"), JSON.stringify(env({ id: "m_a" })));
    writeFileSync(
      join(root, "nimbus/sent/m_b.json"),
      JSON.stringify(env({ id: "m_b", from: "nimbus", to: ["house"] })),
    );
    const r = buildBotCorpus(root, "nimbus");
    assert.equal(r.total, 2);
    assert.equal(r.written, 2);

    const recv = readdirSync(join(root, "nimbus/corpus", CORPUS_DIRS.RECEIVED_DIR));
    const sent = readdirSync(join(root, "nimbus/corpus", CORPUS_DIRS.SENT_DIR));
    assert.deepEqual(recv, ["house__m_a.md"]);
    assert.deepEqual(sent, ["m_b.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("includes compressed archive shards so old mail stays searchable", () => {
  const root = makeRoot();
  try {
    const shard = [JSON.stringify(env({ id: "m_old", body: "archived body" }))].join("\n");
    writeFileSync(join(root, "nimbus/archive/2026-07.jsonl.gz"), gzipSync(Buffer.from(shard, "utf8")));
    buildBotCorpus(root, "nimbus");
    const p = join(root, "nimbus/corpus", CORPUS_DIRS.RECEIVED_DIR, "house__m_old.md");
    assert.ok(existsSync(p));
    assert.match(readFileSync(p, "utf8"), /archived body/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("is idempotent — a second pass rewrites nothing", () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, "nimbus/inbox/house__m_a.json"), JSON.stringify(env({ id: "m_a" })));
    assert.equal(buildBotCorpus(root, "nimbus").written, 1);
    assert.equal(buildBotCorpus(root, "nimbus").written, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PRIVACY: one bot's corpus never contains another bot's mail", () => {
  const root = makeRoot();
  try {
    writeFileSync(
      join(root, "nimbus/inbox/house__m_n.json"),
      JSON.stringify(env({ id: "m_n", body: "NIMBUS_ONLY_SECRET" })),
    );
    writeFileSync(
      join(root, "house/inbox/kolmogorov__m_h.json"),
      JSON.stringify(env({ id: "m_h", from: "kolmogorov", to: ["house"], body: "HOUSE_ONLY_SECRET" })),
    );
    buildAllCorpora(root);

    const readAll = (bot) =>
      readdirSync(join(root, bot, "corpus", CORPUS_DIRS.RECEIVED_DIR))
        .map((f) => readFileSync(join(root, bot, "corpus", CORPUS_DIRS.RECEIVED_DIR, f), "utf8"))
        .join("\n");

    const nimbus = readAll("nimbus");
    const house = readAll("house");
    assert.ok(nimbus.includes("NIMBUS_ONLY_SECRET"));
    assert.ok(!nimbus.includes("HOUSE_ONLY_SECRET"), "nimbus must not see house's mail");
    assert.ok(house.includes("HOUSE_ONLY_SECRET"));
    assert.ok(!house.includes("NIMBUS_ONLY_SECRET"), "house must not see nimbus's mail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skips unparseable envelopes instead of failing the whole pass", () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, "nimbus/inbox/broken.json"), "{not json");
    writeFileSync(join(root, "nimbus/inbox/house__m_ok.json"), JSON.stringify(env({ id: "m_ok" })));
    const r = buildBotCorpus(root, "nimbus");
    assert.equal(r.total, 1);
    assert.equal(r.written, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
