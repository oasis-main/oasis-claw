// Tests for the CLAW-108 observatory feedback queue.
//
// Load-bearing properties:
//   1. A request is not in the queue until every image it announced has
//      arrived with the declared type, size and file signature.
//   2. `pull` writes only text into .swarm/feedback/, never replaces or follows
//      an existing path, and refuses a symlinked folder: a bot (House) can
//      write in that folder.
//   3. The HTTP writes need the token AND this page's Origin, and refuse a body
//      that is too large or of the wrong type.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  FEEDBACK_MAX_CHARS,
  MAX_FILES,
  looksLike,
  openFeedbackStore,
  pullFeedback,
  refFor,
  renderItem,
  validateCreate,
} from "../claw-observatory-feedback.mjs";
import { createObservatoryServer } from "../claw-observatory.mjs";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(20)]);

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const mode = (p) => fs.statSync(p).mode & 0o777;

test("looksLike checks the file signature against the declared type", () => {
  assert.ok(looksLike("image/png", PNG));
  assert.ok(looksLike("image/jpeg", JPEG));
  assert.ok(looksLike("image/webp", WEBP));
  assert.ok(!looksLike("image/png", JPEG));
  assert.ok(!looksLike("image/jpeg", Buffer.from("<svg")));
  assert.ok(!looksLike("image/svg+xml", Buffer.from("<svg")));
  assert.ok(!looksLike("image/png", Buffer.alloc(0)));
});

test("validateCreate trims, limits and refuses", () => {
  const ok = validateCreate({ body: "  fix it \n", context: { view: "live" }, files: [{ name: "a\u0000b.png", contentType: "image/png", bytes: 10 }] });
  assert.equal(ok.body, "fix it");
  assert.equal(ok.files[0].name, "ab.png");
  assert.throws(() => validateCreate(null), /JSON object/);
  assert.throws(() => validateCreate({ body: "   " }), /write what should change/);
  assert.throws(() => validateCreate({ body: "x".repeat(FEEDBACK_MAX_CHARS + 1) }), /longer than/);
  // the limit counts characters, not UTF-16 units
  assert.equal(validateCreate({ body: "😀".repeat(FEEDBACK_MAX_CHARS) }).body.length, FEEDBACK_MAX_CHARS * 2);
  assert.throws(() => validateCreate({ body: "x", context: [] }), /context/);
  assert.throws(() => validateCreate({ body: "x", context: { pad: "y".repeat(3000) } }), /larger than/);
  const file = { name: "a.png", contentType: "image/png", bytes: 1 };
  assert.throws(() => validateCreate({ body: "x", files: Array(MAX_FILES + 1).fill(file) }), /at most/);
  assert.throws(() => validateCreate({ body: "x", files: [{ ...file, contentType: "image/svg+xml" }] }), /PNG, JPEG or WebP/);
  assert.throws(() => validateCreate({ body: "x", files: [{ ...file, contentType: "toString" }] }), /PNG, JPEG or WebP/);
  assert.throws(() => validateCreate({ body: "x", files: [{ ...file, bytes: 0 }] }), /size/);
  assert.throws(() => validateCreate({ body: "x", files: [{ ...file, bytes: 11 * 1024 * 1024 }] }), /size/);
  assert.throws(() => validateCreate({ body: "x", files: [{ ...file, name: "\u0001" }] }), /no name/);
});

test("store: draft, images, submit, list, triage, withdraw", () => {
  const dir = tmp("fb-store-");
  const store = openFeedbackStore(dir);
  try {
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(store.imageDir), 0o700);
    assert.equal(mode(store.dbFile), 0o600);

    const c = store.create(
      {
        body: "The Live view loses my scroll position",
        context: { view: "live", bot: "house" },
        files: [
          { name: "one.png", contentType: "image/png", bytes: PNG.length },
          { name: "two.jpg", contentType: "image/jpeg", bytes: JPEG.length },
        ],
      },
      { author: "mike", extra: { build: "abc1234" } },
    );
    assert.equal(c.ref, refFor(c.id));
    assert.match(c.ref, /^FB-[0-9A-F]{8}$/);
    assert.deepEqual(c.uploads.map((u) => u.url), [`/api/feedback/${c.id}/files/1`, `/api/feedback/${c.id}/files/2`]);

    // a draft is not in the queue and cannot be triaged
    assert.equal(store.list().length, 0);
    assert.throws(() => store.setStatus(c.ref, "done"), (e) => e.status === 409);
    assert.throws(() => store.submit(c.id), (e) => e.status === 409 && /one\.png, two\.jpg/.test(e.message));

    assert.throws(() => store.storeFile(c.id, 1, "image/jpeg", PNG), (e) => e.status === 415);
    assert.throws(() => store.storeFile(c.id, 1, "image/png", Buffer.concat([PNG, Buffer.from("x")])), (e) => e.status === 413);
    assert.throws(() => store.storeFile(c.id, 1, "image/png", Buffer.from("not a png at all, but long enough")), (e) => e.status === 400);
    assert.throws(() => store.storeFile(c.id, 1, "image/png", Buffer.alloc(0)), (e) => e.status === 400);
    assert.throws(() => store.storeFile(c.id, 3, "image/png", PNG), (e) => e.status === 404);
    store.storeFile(c.id, 1, "image/png", PNG);
    assert.throws(() => store.submit(c.id), (e) => e.status === 409 && /two\.jpg/.test(e.message) && !/one\.png/.test(e.message));
    store.storeFile(c.id, 2, "image/jpeg", JPEG.subarray(0, 30));

    const sent = store.submit(c.id);
    assert.equal(sent.status, "new");
    assert.equal(sent.author, "mike");
    assert.deepEqual(sent.context, { view: "live", bot: "house", build: "abc1234" });
    assert.deepEqual(sent.attachments.map((a) => [a.seq, a.bytes, a.stored]), [[1, PNG.length, true], [2, 30, true]]);
    for (const a of sent.attachments) {
      assert.equal(path.dirname(a.path), store.imageDir);
      assert.equal(mode(a.path), 0o600);
    }
    assert.deepEqual(fs.readdirSync(store.imageDir).sort(), [`${c.ref}-1.png`, `${c.ref}-2.jpg`]);
    assert.throws(() => store.storeFile(c.id, 1, "image/png", PNG), (e) => e.status === 409);
    assert.equal(store.submit(c.id).status, "new", "a second submit changes nothing");

    assert.equal(store.get(c.ref.toLowerCase()).id, c.id);
    assert.throws(() => store.get("FB-00000000"), (e) => e.status === 404);
    assert.throws(() => store.get("../../etc"), (e) => e.status === 400);
    assert.deepEqual(store.list({ status: "new" }).map((f) => f.ref), [c.ref]);
    assert.throws(() => store.list({ status: "new,bogus" }), (e) => e.status === 400);
    assert.throws(() => store.list({ limit: 0 }), (e) => e.status === 400);

    const done = store.setStatus(c.ref, "done", "fixed in the page");
    assert.equal(done.status, "done");
    assert.equal(done.resolution, "fixed in the page");
    assert.equal(store.setStatus(c.ref, "in_progress").resolution, "fixed in the page", "no note keeps the old one");
    assert.throws(() => store.setStatus(c.ref, "draft"), (e) => e.status === 400);
    assert.throws(() => store.withdraw(c.ref), (e) => e.status === 409);

    const other = store.create({ body: "second", files: [{ name: "w.webp", contentType: "image/webp", bytes: WEBP.length }] });
    store.storeFile(other.id, 1, "image/webp", WEBP);
    store.submit(other.id);
    store.withdraw(other.ref);
    assert.throws(() => store.get(other.id), (e) => e.status === 404);
    assert.ok(!fs.existsSync(path.join(store.imageDir, `${other.ref}-1.webp`)));
  } finally {
    store.close();
  }
});

test("store: reopening keeps the data; a stale draft is removed with its images", () => {
  const dir = tmp("fb-reopen-");
  let clock = new Date("2026-09-16T10:00:00Z");
  const now = () => clock;
  const first = openFeedbackStore(dir, { now });
  const kept = first.create({ body: "kept" });
  first.submit(kept.id);
  const stale = first.create({ body: "abandoned", files: [{ name: "a.png", contentType: "image/png", bytes: PNG.length }] });
  first.storeFile(stale.id, 1, "image/png", PNG);
  first.close();

  clock = new Date("2026-09-17T11:00:00Z");
  const second = openFeedbackStore(dir, { now });
  try {
    assert.equal(second.get(kept.ref).status, "new");
    assert.throws(() => second.get(stale.id), (e) => e.status === 404);
    assert.deepEqual(fs.readdirSync(second.imageDir), []);
  } finally {
    second.close();
  }
});

function submitted(store, body, withImage = true) {
  const c = store.create({
    body,
    context: { view: "agents", bot: "house", agentTab: "memory" },
    files: withImage ? [{ name: "shot [1].png", contentType: "image/png", bytes: PNG.length }] : [],
  });
  if (withImage) store.storeFile(c.id, 1, "image/png", PNG);
  return store.submit(c.id);
}

test("pull: text only, oldest first, never over an existing path", () => {
  const dir = tmp("fb-pull-");
  let tick = 0;
  const store = openFeedbackStore(path.join(dir, "state"), { now: () => new Date(Date.UTC(2026, 8, 16, 10, 0, tick++)) });
  const swarm = path.join(dir, "swarm");
  fs.mkdirSync(swarm);
  const out = path.join(swarm, "feedback");
  try {
    const a = submitted(store, "First: the tab overlaps the header\nmore detail");
    const b = submitted(store, "Second request", false);
    const c = submitted(store, "Third request", false);

    // a bot planted a file (as a symlink to a host file) under one reference
    fs.mkdirSync(out);
    const victim = path.join(dir, "victim.txt");
    fs.writeFileSync(victim, "unchanged");
    fs.symlinkSync(victim, path.join(out, `${c.ref}.md`));

    assert.deepEqual(
      pullFeedback(store, out, { dryRun: true }).map((r) => r.ref),
      [a.ref, b.ref, c.ref],
    );
    assert.equal(store.get(a.ref).status, "new", "a dry run changes nothing");

    const results = pullFeedback(store, out);
    assert.deepEqual(results.map((r) => [r.ref, r.action]), [[a.ref, "queued"], [b.ref, "queued"], [c.ref, "left alone"]]);
    assert.equal(fs.readFileSync(victim, "utf8"), "unchanged");
    assert.equal(store.get(a.ref).status, "queued");
    assert.equal(store.get(c.ref).status, "new");

    const md = fs.readFileSync(path.join(out, `${a.ref}.md`), "utf8");
    assert.match(md, new RegExp(`^---\\nref: ${a.ref}\\n`));
    assert.match(md, /status: queued/);
    assert.match(md, /bot: "house"/);
    assert.match(md, new RegExp(`# ${a.ref}: First: the tab overlaps the header\\n`));
    const image = store.get(a.ref).attachments[0].path;
    assert.ok(md.includes(`![shot  1 .png](<${image}>)`), md);
    // only the text went to the shared folder
    assert.deepEqual(fs.readdirSync(out).sort(), [`${a.ref}.md`, `${b.ref}.md`, `${c.ref}.md`].sort());
    assert.ok(!md.includes("PNG"));

    assert.deepEqual(pullFeedback(store, out).map((r) => r.action), ["left alone"]);
  } finally {
    store.close();
  }
});

test("pull refuses a symlinked or misplaced folder", () => {
  const dir = tmp("fb-pull-link-");
  const store = openFeedbackStore(path.join(dir, "state"));
  try {
    submitted(store, "one", false);
    const elsewhere = path.join(dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    const swarm = path.join(dir, "swarm");
    fs.mkdirSync(swarm);
    fs.symlinkSync(elsewhere, path.join(swarm, "feedback"));
    assert.throws(() => pullFeedback(store, path.join(swarm, "feedback")), /not a real folder/);
    fs.writeFileSync(path.join(swarm, "file"), "");
    assert.throws(() => pullFeedback(store, path.join(swarm, "file")), /not a real folder/);
    assert.throws(() => pullFeedback(store, path.join(dir, "missing", "feedback")), /is not a folder/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  } finally {
    store.close();
  }
});

test("renderItem keeps the front matter to one line per value", () => {
  const md = renderItem({
    ref: "FB-0000ABCD",
    id: "0000abcd-0000-4000-8000-000000000000",
    author: "mike",
    submittedAt: "2026-09-16T10:00:00.000Z",
    body: "x",
    context: { view: "live\n---\nstatus: done", bot: null },
    attachments: [],
  });
  const front = md.split("---\n")[1];
  assert.match(front, /view: "live\\n---\\nstatus: done"/);
  assert.equal((md.match(/^status:/gm) ?? []).length, 1);
  assert.match(front, /bot: null/);
  assert.ok(!md.includes("## Screenshots"));
});

test("server: feedback writes need the token and this page's Origin", async () => {
  const dir = tmp("fb-server-");
  const store = openFeedbackStore(dir);
  const ctx = {
    port: 0,
    token: "t".repeat(43),
    author: "mike",
    build: "abc1234",
    discover: async () => ({ bots: [], proxy: null }),
    swarm: { port: 1, url: "http://127.0.0.1:1/" },
    snapshotDir: tmp("fb-snap-"),
    mailRoot: tmp("fb-mail-"),
    proxyKey: () => "k".repeat(43),
    identities: { get: () => null },
    feedbackStore: async () => store,
    maxImageBytes: 1024,
  };
  const server = createObservatoryServer(ctx);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  ctx.port = server.address().port;
  const origin = `http://127.0.0.1:${ctx.port}`;
  const call = (pathname, { method = "GET", headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: ctx.port, path: pathname, method, headers: { host: `127.0.0.1:${ctx.port}`, ...headers }, agent: false },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, json: text ? JSON.parse(text) : null }));
        },
      );
      // a refused upload may close the socket before the body is written
      req.on("error", (err) => (err.code === "EPIPE" || err.code === "ECONNRESET" ? resolve({ status: "reset" }) : reject(err)));
      req.end(body);
    });
  const auth = { "x-observatory-token": ctx.token };
  const write = { ...auth, origin };
  const json = { ...write, "content-type": "application/json" };
  const create = (payload, headers = json) => call("/api/feedback", { method: "POST", headers, body: JSON.stringify(payload) });
  const payload = { body: "Make the tab smaller", context: { view: "work" }, files: [{ name: "s.png", contentType: "image/png", bytes: PNG.length }] };
  try {
    assert.equal((await create(payload, { "content-type": "application/json", origin })).status, 401, "no token");
    assert.equal((await create(payload, { ...auth, "content-type": "application/json" })).status, 403, "no Origin");
    assert.equal((await create(payload, { ...json, origin: "https://evil.example" })).status, 403, "foreign Origin");
    assert.equal((await create(payload, { ...write, "content-type": "text/plain" })).status, 415);
    assert.equal((await call("/api/feedback", { method: "POST", headers: json, body: "{" })).status, 400);
    const big = await call("/api/feedback", { method: "POST", headers: json, body: JSON.stringify({ body: "x".repeat(40_000) }) });
    assert.ok(big.status === 413 || big.status === "reset", `big body: ${big.status}`);
    assert.equal((await call("/api/fleet", { method: "POST", headers: json, body: "{}" })).status, 405, "other paths stay read-only");
    assert.equal((await call("/api/feedback", { method: "PATCH", headers: json, body: "{}" })).status, 405);

    const created = await create(payload);
    assert.equal(created.status, 201);
    const { id, ref } = created.json;
    const put = (bytes, type = "image/png", seq = 1) => call(`/api/feedback/${id}/files/${seq}`, { method: "PUT", headers: { ...write, "content-type": type }, body: bytes });
    assert.equal((await call(`/api/feedback/${id}/submit`, { method: "POST", headers: write })).status, 409, "image missing");
    assert.equal((await put(PNG, "image/jpeg")).status, 415);
    assert.equal((await put(PNG, "image/png", 7)).status, 404);
    assert.equal((await put(PNG, "image/png", "0")).status, 404);
    const huge = await put(Buffer.concat([PNG, Buffer.alloc(2048)]));
    assert.ok(huge.status === 413 || huge.status === "reset", `huge image: ${huge.status}`);
    assert.equal((await put(PNG)).status, 204);
    const sent = await call(`/api/feedback/${id}/submit`, { method: "POST", headers: write });
    assert.equal(sent.status, 200);
    assert.equal(sent.json.status, "new");
    assert.deepEqual(sent.json.context, { view: "work", build: "abc1234" });
    assert.equal(sent.json.author, "mike");
    assert.equal(sent.json.attachments[0].path, undefined, "the page never learns the host path");

    const list = await call("/api/feedback?limit=5", { headers: auth });
    assert.deepEqual(list.json.feedback.map((f) => f.ref), [ref]);
    assert.equal((await call("/api/feedback?status=bogus", { headers: auth })).status, 400);
    assert.equal((await call(`/api/feedback/${id}`, { headers: auth })).json.ref, ref);
    assert.equal((await call("/api/feedback/not-an-id", { headers: auth })).status, 404);

    store.setStatus(ref, "queued");
    assert.equal((await call(`/api/feedback/${id}`, { method: "DELETE", headers: write })).status, 409);
    store.setStatus(ref, "new");
    assert.equal((await call(`/api/feedback/${id}`, { method: "DELETE", headers: auth })).status, 403, "no Origin");
    assert.equal((await call(`/api/feedback/${id}`, { method: "DELETE", headers: write })).status, 204);
    assert.equal((await call(`/api/feedback/${id}`, { headers: auth })).status, 404);
  } finally {
    server.close();
    store.close();
  }
});
