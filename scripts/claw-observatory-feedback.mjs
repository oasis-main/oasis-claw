// ── claw-observatory feedback queue (CLAW-108) ───────────────────────────────
// Change requests written from inside the observatory page, with screenshots.
// The flow is the one in oasis-kinematics web/api/app/routers/feedback.py:
//
//   1. POST /api/feedback                 text + context + the list of images
//                                         to come -> a draft, one slot per image
//   2. PUT  /api/feedback/{id}/files/{n}  the bytes of image n
//   3. POST /api/feedback/{id}/submit     checks that every announced image
//                                         arrived, then status -> new
//
// `new` requests are the queue. `claw-observatory.mjs feedback pull` writes each
// one to oasis-claw/.swarm/feedback/<ref>.md and moves it to `queued`. One file
// per request, so two sessions that pull at the same time never rewrite the
// same file.
//
// WHERE THE DATA LIVES — read before moving it
//   The database and the images live in
//   ~/Library/Application Support/oasis-x/observatory/feedback/, which no bot
//   mounts. A screenshot of the observatory shows other agents' memories and
//   transcripts, and no agent may read those (Mike, 2026-08-10).
//   oasis-claw/.swarm IS mounted into two bots (measured 2026-09-16):
//     House    /reach/claw-swarm                    read-write
//     Yes Man  /reach/runes/oasis-x/oasis-claw      read-only
//   So `pull` copies only the text there. Each image stays in the state folder
//   and the item names it by its absolute path.
//   House can write into .swarm/feedback/. `pull` therefore never follows or
//   replaces an existing path, refuses a symlinked folder, and the database —
//   not the folder — is the list of record (`feedback list`).
//
// RECIPIENTS (Mike, 2026-10-07, R5)
//   Each request names the bots it goes to (default: the primary Oasis-X bots,
//   Kolmogorov, Hello World and ButterBolt). On submit, the observatory writes
//   one console mail per bot into the mail outbox; the relay applies its routes
//   and audit as for any console mail. The mail carries the text and the page
//   context only, never an image. feedback_delivery records each mail id or
//   error. To a bot, console mail is a request to consider, not an
//   authorization.
//
// The store uses node:sqlite (Node 22.13 or later). claw-observatory.mjs loads
// this module only for `serve` and `feedback`, so the launchd copy of that
// script (snapshot only) does not need this file.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const FEEDBACK_MAX_CHARS = 4000;
export const MAX_FILES = 6;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const CONTEXT_MAX_BYTES = 2000;
export const MAX_RECIPIENTS = 8;
const BOT_KEY_RE = /^[a-z0-9-]{1,40}$/;
export const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
export const STATUSES = ["draft", "new", "queued", "in_progress", "done", "declined"];
const TRIAGE_STATUSES = STATUSES.filter((s) => s !== "draft");
// A draft exists only while its images upload. One older than this failed
// part-way and nobody can see it, so opening the store removes it.
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REF_RE = /^FB-[0-9A-F]{8}$/;

export class FeedbackError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const refFor = (id) => `FB-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;

/** The file signature must match the declared type. The declared type alone
 *  would let any file be stored and later opened as an "image". */
export function looksLike(contentType, head) {
  const b = Buffer.from(head ?? []);
  if (contentType === "image/png") return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === "image/jpeg") return b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (contentType === "image/webp") return b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}

const charCount = (s) => [...s].length;

/** Validate the body of POST /api/feedback. Throws FeedbackError(400). */
export function validateCreate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new FeedbackError(400, "the request body must be a JSON object");
  }
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) throw new FeedbackError(400, "write what should change");
  if (charCount(body) > FEEDBACK_MAX_CHARS) {
    throw new FeedbackError(400, `the text is longer than ${FEEDBACK_MAX_CHARS} characters`);
  }
  const context = input.context ?? {};
  if (typeof context !== "object" || context === null || Array.isArray(context)) {
    throw new FeedbackError(400, "context must be a JSON object");
  }
  if (Buffer.byteLength(JSON.stringify(context)) > CONTEXT_MAX_BYTES) {
    throw new FeedbackError(400, `context is larger than ${CONTEXT_MAX_BYTES} bytes`);
  }
  const files = input.files ?? [];
  if (!Array.isArray(files)) throw new FeedbackError(400, "files must be a list");
  if (files.length > MAX_FILES) throw new FeedbackError(400, `at most ${MAX_FILES} images`);
  const clean = files.map((f, i) => {
    const name = typeof f?.name === "string" ? f.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) : "";
    if (!name) throw new FeedbackError(400, `image ${i + 1} has no name`);
    if (!Object.hasOwn(IMAGE_TYPES, f.contentType)) {
      throw new FeedbackError(400, `${name}: only PNG, JPEG or WebP images`);
    }
    if (!Number.isInteger(f.bytes) || f.bytes < 1 || f.bytes > MAX_FILE_BYTES) {
      throw new FeedbackError(400, `${name}: the size must be 1 byte to ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    }
    return { name, contentType: f.contentType, bytes: f.bytes };
  });
  // `to` absent: the server's default recipients. An empty list: queue only.
  let to = null;
  if (input.to !== undefined) {
    if (!Array.isArray(input.to)) throw new FeedbackError(400, "to must be a list of bot names");
    to = [...new Set(input.to)];
    if (to.length > MAX_RECIPIENTS) throw new FeedbackError(400, `at most ${MAX_RECIPIENTS} recipients`);
    for (const bot of to) {
      if (typeof bot !== "string" || !BOT_KEY_RE.test(bot)) throw new FeedbackError(400, "a recipient is not a bot name");
    }
  }
  return { body, context, files: clean, to };
}

const MIGRATIONS = [
  `CREATE TABLE feedback (
     id           TEXT PRIMARY KEY,
     ref          TEXT NOT NULL UNIQUE,
     status       TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','new','queued','in_progress','done','declined')),
     body         TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND ${FEEDBACK_MAX_CHARS}),
     context      TEXT NOT NULL DEFAULT '{}',
     resolution   TEXT,
     author       TEXT,
     created_at   TEXT NOT NULL,
     submitted_at TEXT,
     updated_at   TEXT NOT NULL
   ) STRICT;
   CREATE INDEX feedback_status_created ON feedback (status, created_at);
   CREATE TABLE feedback_attachment (
     feedback_id  TEXT NOT NULL REFERENCES feedback (id) ON DELETE CASCADE,
     seq          INTEGER NOT NULL CHECK (seq BETWEEN 1 AND ${MAX_FILES}),
     name         TEXT NOT NULL,
     content_type TEXT NOT NULL,
     bytes        INTEGER NOT NULL,
     file         TEXT NOT NULL,
     stored       INTEGER NOT NULL DEFAULT 0,
     created_at   TEXT NOT NULL,
     PRIMARY KEY (feedback_id, seq)
   ) STRICT;`,
  // R5 (2026-10-07): who each request goes to, and what happened to each mail.
  `CREATE TABLE feedback_delivery (
     feedback_id  TEXT NOT NULL REFERENCES feedback (id) ON DELETE CASCADE,
     bot          TEXT NOT NULL,
     mail_id      TEXT,
     error        TEXT,
     sent_at      TEXT,
     PRIMARY KEY (feedback_id, bot)
   ) STRICT;`,
];

function migrate(db) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export const fileUrl = (id, seq) => `/api/feedback/${id}/files/${seq}`;

/** Open (and create) the store in `dir`. */
export function openFeedbackStore(dir, { now = () => new Date() } = {}) {
  const imageDir = path.join(dir, "images");
  fs.mkdirSync(imageDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.chmodSync(imageDir, 0o700);
  const dbFile = path.join(dir, "feedback.db");
  const db = new DatabaseSync(dbFile);
  fs.chmodSync(dbFile, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);

  const iso = () => now().toISOString();
  const q = {
    byId: db.prepare("SELECT * FROM feedback WHERE id = ?"),
    byRef: db.prepare("SELECT * FROM feedback WHERE ref = ?"),
    atts: db.prepare("SELECT * FROM feedback_attachment WHERE feedback_id = ? ORDER BY seq"),
    att: db.prepare("SELECT * FROM feedback_attachment WHERE feedback_id = ? AND seq = ?"),
    insert: db.prepare(
      "INSERT INTO feedback (id, ref, status, body, context, author, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)",
    ),
    insertAtt: db.prepare(
      "INSERT INTO feedback_attachment (feedback_id, seq, name, content_type, bytes, file, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ),
    stored: db.prepare("UPDATE feedback_attachment SET stored = 1, bytes = ? WHERE feedback_id = ? AND seq = ?"),
    submit: db.prepare("UPDATE feedback SET status = 'new', submitted_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'"),
    triage: db.prepare("UPDATE feedback SET status = ?, resolution = COALESCE(?, resolution), updated_at = ? WHERE id = ?"),
    remove: db.prepare("DELETE FROM feedback WHERE id = ?"),
    staleDrafts: db.prepare("SELECT id FROM feedback WHERE status = 'draft' AND created_at < ?"),
    deliveries: db.prepare("SELECT * FROM feedback_delivery WHERE feedback_id = ? ORDER BY rowid"),
    insertDelivery: db.prepare("INSERT INTO feedback_delivery (feedback_id, bot) VALUES (?, ?)"),
    delivered: db.prepare("UPDATE feedback_delivery SET mail_id = ?, error = ?, sent_at = ? WHERE feedback_id = ? AND bot = ?"),
  };

  const imagePath = (file) => path.join(imageDir, file);

  const out = (f) => ({
    id: f.id,
    ref: f.ref,
    status: f.status,
    body: f.body,
    context: JSON.parse(f.context),
    resolution: f.resolution,
    author: f.author,
    createdAt: f.created_at,
    submittedAt: f.submitted_at,
    updatedAt: f.updated_at,
    attachments: q.atts.all(f.id).map((a) => ({
      seq: a.seq,
      name: a.name,
      contentType: a.content_type,
      bytes: a.bytes,
      stored: a.stored === 1,
      path: imagePath(a.file),
    })),
    deliveries: q.deliveries.all(f.id).map((d) => ({ bot: d.bot, mailId: d.mail_id, error: d.error, sentAt: d.sent_at })),
  });

  function load(idOrRef) {
    const key = String(idOrRef ?? "");
    let row;
    if (ID_RE.test(key)) row = q.byId.get(key);
    else if (REF_RE.test(key.toUpperCase())) row = q.byRef.get(key.toUpperCase());
    else throw new FeedbackError(400, "not a request id or FB- reference");
    if (!row) throw new FeedbackError(404, "no such request");
    return row;
  }

  function removeWithFiles(id) {
    const files = q.atts.all(id).map((a) => imagePath(a.file));
    q.remove.run(id);
    for (const file of files) fs.rmSync(file, { force: true });
  }

  const store = {
    dir,
    imageDir,
    dbFile,

    /** `extra` is context the server adds after validation (the build).
     *  `defaultTo` is used when the page names no recipients; `knownBots`,
     *  when given, refuses a recipient that is not in the fleet. */
    create(input, { author = null, extra = {}, defaultTo = [], knownBots = null } = {}) {
      const { body, context, files, to } = validateCreate(input);
      const recipients = to ?? defaultTo;
      const unknown = knownBots ? recipients.filter((b) => !knownBots.includes(b)) : [];
      if (unknown.length) throw new FeedbackError(400, `not a bot in the fleet: ${unknown.join(", ")}`);
      const t = iso();
      return transaction(db, () => {
        let id;
        let ref;
        do {
          id = crypto.randomUUID();
          ref = refFor(id);
        } while (q.byRef.get(ref));
        q.insert.run(id, ref, body, JSON.stringify({ ...context, ...extra }), author, t, t);
        files.forEach((f, i) => {
          q.insertAtt.run(id, i + 1, f.name, f.contentType, f.bytes, `${ref}-${i + 1}.${IMAGE_TYPES[f.contentType]}`, t);
        });
        for (const bot of recipients) q.insertDelivery.run(id, bot);
        return {
          id,
          ref,
          uploads: files.map((f, i) => ({ seq: i + 1, url: fileUrl(id, i + 1), contentType: f.contentType, maxBytes: f.bytes })),
        };
      });
    },

    storeFile(id, seqRaw, contentType, data) {
      const f = load(id);
      if (f.status !== "draft") throw new FeedbackError(409, "this request is already sent");
      const seq = Number(seqRaw);
      const a = Number.isInteger(seq) ? q.att.get(f.id, seq) : undefined;
      if (!a) throw new FeedbackError(404, "no such image slot");
      if (contentType !== a.content_type) throw new FeedbackError(415, `this image slot takes ${a.content_type}`);
      if (!data?.length) throw new FeedbackError(400, `${a.name} is empty`);
      if (data.length > a.bytes) throw new FeedbackError(413, `${a.name} is larger than announced`);
      if (!looksLike(a.content_type, data.subarray(0, 16))) {
        throw new FeedbackError(400, `${a.name} is not a ${a.content_type} file`);
      }
      const target = imagePath(a.file);
      const tmp = `${target}.${crypto.randomBytes(6).toString("hex")}.part`;
      fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, target);
      q.stored.run(data.length, f.id, seq);
    },

    /** Record what happened to one recipient's mail. */
    recordDelivery(id, bot, { mailId = null, error = null } = {}) {
      const f = load(id);
      q.delivered.run(mailId, error, iso(), f.id, bot);
    },

    submit(id) {
      const f = load(id);
      if (f.status !== "draft") return out(f);
      const missing = q.atts.all(f.id).filter((a) => a.stored !== 1 || !fs.existsSync(imagePath(a.file)));
      if (missing.length) {
        throw new FeedbackError(409, `these images did not arrive: ${missing.map((a) => a.name).join(", ")}`);
      }
      const t = iso();
      q.submit.run(t, t, f.id);
      return out(load(f.id));
    },

    list({ status, limit = 50 } = {}) {
      const wanted = status
        ? String(status)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : TRIAGE_STATUSES;
      if (!wanted.length || wanted.some((s) => !STATUSES.includes(s))) {
        throw new FeedbackError(400, `status must be one or more of: ${STATUSES.join(", ")}`);
      }
      const n = Number(limit);
      if (!Number.isInteger(n) || n < 1 || n > 500) throw new FeedbackError(400, "limit must be 1 to 500");
      const rows = db
        .prepare(`SELECT * FROM feedback WHERE status IN (${wanted.map(() => "?").join(", ")}) ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all(...wanted, n);
      return rows.map(out);
    },

    get(idOrRef) {
      return out(load(idOrRef));
    },

    setStatus(idOrRef, status, note) {
      if (!TRIAGE_STATUSES.includes(status)) {
        throw new FeedbackError(400, `status must be one of: ${TRIAGE_STATUSES.join(", ")}`);
      }
      if (note != null && charCount(String(note)) > FEEDBACK_MAX_CHARS) {
        throw new FeedbackError(400, `the note is longer than ${FEEDBACK_MAX_CHARS} characters`);
      }
      const f = load(idOrRef);
      if (f.status === "draft") throw new FeedbackError(409, "a draft cannot be triaged");
      q.triage.run(status, note ?? null, iso(), f.id);
      return out(load(f.id));
    },

    /** Only a request that nobody has queued yet can be withdrawn. */
    withdraw(idOrRef) {
      const f = load(idOrRef);
      if (f.status !== "draft" && f.status !== "new") {
        throw new FeedbackError(409, `${f.ref} is ${f.status}; only an unqueued request can be withdrawn`);
      }
      transaction(db, () => removeWithFiles(f.id));
    },

    pruneDrafts() {
      const cutoff = new Date(now().getTime() - DRAFT_TTL_MS).toISOString();
      const stale = q.staleDrafts.all(cutoff);
      if (stale.length) transaction(db, () => stale.forEach((r) => removeWithFiles(r.id)));
      return stale.length;
    },

    close() {
      db.close();
    },
  };
  store.pruneDrafts();
  return store;
}

// ── pull: new requests -> .swarm/feedback/<ref>.md ──────────────────────────

// A value in the front matter: one line, and a JSON string when it is text
// (a JSON string is a valid YAML scalar).
function scalar(v) {
  if (v == null || v === "") return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(String(v).slice(0, 300));
}

const mdText = (s) => String(s).replace(/[\r\n[\]<>]/g, " ");

export function renderItem(item) {
  const ctx = item.context ?? {};
  const first = item.body.trim().split("\n")[0].slice(0, 80);
  const lines = [
    "---",
    `ref: ${item.ref}`,
    `id: ${item.id}`,
    "status: queued",
    `author: ${scalar(item.author)}`,
    `submitted: ${scalar(item.submittedAt)}`,
    `view: ${scalar(ctx.view)}`,
    `bot: ${scalar(ctx.bot)}`,
    `session: ${scalar(ctx.session)}`,
    `build: ${scalar(ctx.build)}`,
    `mailed_to: ${scalar((item.deliveries ?? []).filter((d) => d.mailId).map((d) => d.bot).join(", ") || null)}`,
    "---",
    "",
    `# ${item.ref}: ${first}`,
    "",
    item.body.trim(),
    "",
    "The live status is in the observatory database: `make feedback-show REF=" + item.ref + "`.",
    "",
  ];
  const stored = item.attachments.filter((a) => a.stored);
  if (stored.length) {
    lines.push(
      "## Screenshots",
      "",
      "The images stay in the observatory state folder, which no bot mounts. Open them from these paths:",
      "",
      ...stored.map((a) => `![${mdText(a.name)}](<${a.path}>)`),
      "",
    );
  }
  lines.push("## Context captured by the observatory", "", "```json", JSON.stringify(ctx, null, 2), "```", "");
  return lines.join("\n");
}

/** The pull target must be a real folder directly inside a real parent. A bot
 *  with write access to the parent could otherwise point it somewhere else. */
export function ensurePullDir(outDir) {
  const parent = path.dirname(path.resolve(outDir));
  const parentStat = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (!parentStat?.isDirectory()) throw new Error(`${parent} is not a folder`);
  const stat = fs.lstatSync(outDir, { throwIfNoEntry: false });
  if (!stat) fs.mkdirSync(outDir);
  else if (!stat.isDirectory()) throw new Error(`${outDir} is not a real folder (a symlink or a file); pull refuses to write through it`);
  const real = fs.realpathSync(outDir);
  if (real !== path.join(fs.realpathSync(parent), path.basename(outDir))) {
    throw new Error(`${outDir} resolves to ${real}; pull refuses to write there`);
  }
  return real;
}

/** Write each `new` request to outDir, oldest first, and mark it `queued`. */
export function pullFeedback(store, outDir, { dryRun = false } = {}) {
  const items = store.list({ status: "new", limit: 500 }).reverse();
  const results = [];
  if (!items.length || dryRun) {
    return items.map((item) => ({ ref: item.ref, action: "would pull", first: item.body.split("\n")[0].slice(0, 70) }));
  }
  const dir = ensurePullDir(outDir);
  for (const item of items) {
    const file = path.join(dir, `${item.ref}.md`);
    try {
      // "wx" fails on any existing path, a dangling symlink included.
      fs.writeFileSync(file, renderItem(item), { flag: "wx", mode: 0o644 });
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      results.push({ ref: item.ref, action: "left alone", file, note: "the file already exists; the request stays new" });
      continue;
    }
    store.setStatus(item.id, "queued");
    results.push({ ref: item.ref, action: "queued", file });
  }
  return results;
}
