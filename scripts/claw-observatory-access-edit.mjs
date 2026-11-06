// ── claw-observatory-access-edit: Access edits, phase 2 (Mike, 2026-11-06) ──
// Step 5 part 1 of the identity plan (shared notes §1.3 "Phase 2", and the
// implementation sequence: "each widening is a signed decision"). The Access
// view can change two settings that a restart applies:
//   - tools.alsoAllow in the bot's role.yaml (bots/<bot>/role.yaml, mounted
//     read-only at /app/role.yaml): the tools past the tools.profile filter;
//   - the bot's reviewer write roots (hard.per_bot.<key>.allowWriteRoots in
//     bots/reviewer-policy.local.json), merged into bots/.runtime/
//     reviewer-policy.json, which every bot mounts read-only.
//
// RULES (the server enforces them; the page is not the only check):
//   - An add is a widening: Mike's root key signs it (Touch ID). A remove is
//     a tightening: the hub key signs it (one click). The event goes into the
//     authority log's `access` stream BEFORE the file changes, with the hash
//     of the file before and after (claw-authority.mjs authorizeAccess).
//   - No widening for a Level C bot (allowlist exec in the SSH sandbox).
//   - A tool is a plain name. A write root is a path under /reach/ that is
//     not and does not hold the fleet's plumbing. The last write root cannot
//     be removed: an empty list means no write scope at all
//     (extensions/oasis-reviewer/src/policy.ts allowWriteRoots).
//   - Compare-and-swap: the page sends the hash of the file it showed, and a
//     file that changed since is refused. No symlink is followed. The text
//     that an edit replaces is kept in the state folder.
//   - role.yaml and the merged policy are single-file bind mounts, so both
//     are written in place (same inode), never through a rename.
//   - Nothing restarts here; the page offers the restart.
// A tool that role.yaml drops leaves the running config at the next boot
// only with an image that has the entrypoint's role-list pruning (step 5).
//
// Loaded only by `serve` (dynamic import), as claw-observatory-access.mjs.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { accessWidening, appendEvent, loadAuthority, loadHubSigner, streamErrors } from "./claw-authority.mjs";
import { ROLE_MOUNT, ROLE_PY, accessEnv, accessLevel, policyKey } from "./claw-observatory-access.mjs";
import { oneSignature } from "./claw-observatory-authority.mjs";

export const TOOL_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const ROOT_RE = /^\/reach(?:\/[A-Za-z0-9._-]+)+$/;
// The fleet's plumbing under /reach: a write root may not be one of these or
// hold one. /reach/fleet holds each bot's own status folder, which a write
// root may name.
export const PLUMBING = ["/reach/authority", "/reach/approvals", "/reach/mail", "/reach/fleet"];
const NO_ROOT_INSIDE = ["/reach/authority", "/reach/approvals", "/reach/mail"];
export const HISTORY_KEEP = 50;

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const under = (p, root) => p === root || p.startsWith(`${root}/`);

// ── role.yaml: tools.alsoAllow ───────────────────────────────────────────────

/** The one-line `alsoAllow: [a, b]` of the top-level tools block, or { error }. */
export function roleAlsoAllow(text) {
  const lines = text.split("\n");
  const starts = lines.flatMap((l, i) => (/^tools:\s*(#.*)?$/.test(l) ? [i] : []));
  if (!starts.length) return { error: "role.yaml has no top-level tools block" };
  // PyYAML keeps the LAST of two equal keys: an edit of the first would not count.
  if (starts.length > 1) return { error: "role.yaml has more than one tools block: edit it by hand" };
  const start = starts[0];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const hits = [];
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^(\s+)alsoAllow:\s*\[([^\]#]*)\]\s*(#.*)?$/);
    if (m) hits.push({ i, indent: m[1], inner: m[2], comment: m[3] ?? "" });
    else if (/^\s+alsoAllow:/.test(lines[i])) return { error: "tools.alsoAllow is not a one-line [a, b] list: edit role.yaml by hand" };
  }
  if (hits.length !== 1) return { error: hits.length ? "tools.alsoAllow is in role.yaml more than once" : "role.yaml has no tools.alsoAllow line" };
  const items = hits[0].inner.split(",").map((s) => s.trim()).filter(Boolean);
  if (!items.every((x) => TOOL_RE.test(x))) return { error: "tools.alsoAllow holds a quoted or unusual name: edit role.yaml by hand" };
  return { items, line: hits[0], lines };
}

/** role.yaml with one tool added or removed, changing only that one line. */
export function editRoleAlsoAllow(text, op, tool) {
  if (!TOOL_RE.test(String(tool))) return { error: "a tool name is lowercase letters, digits, _ . -" };
  const r = roleAlsoAllow(text);
  if (r.error) return r;
  const has = r.items.includes(tool);
  if (op === "add" && has) return { error: `${tool} is in tools.alsoAllow already` };
  if (op === "remove" && !has) return { error: `${tool} is not in tools.alsoAllow` };
  const items = op === "add" ? [...r.items, tool] : r.items.filter((x) => x !== tool);
  const lines = [...r.lines];
  lines[r.line.i] = `${r.line.indent}alsoAllow: [${items.join(", ")}]${r.line.comment ? `  ${r.line.comment}` : ""}`;
  const out = lines.join("\n");
  const back = roleAlsoAllow(out);
  if (back.error || back.items.join(",") !== items.join(",")) return { error: "the edit does not read back: edit role.yaml by hand" };
  return { text: out, items };
}

// ── the reviewer policy: write roots ─────────────────────────────────────────

/** null, or why `root` cannot be a write root. */
export function writeRootProblem(root) {
  if (typeof root !== "string" || !ROOT_RE.test(root)) return "a write root is a path under /reach/ (letters, digits, . _ -), with no trailing slash";
  if (root.split("/").some((s) => s === "." || s === "..")) return "a write root has no . or .. part";
  for (const p of PLUMBING) if (under(p, root)) return `${root} is or holds the fleet's plumbing (${p})`;
  for (const p of NO_ROOT_INSIDE) if (under(root, p)) return `${root} is inside the fleet's plumbing (${p})`;
  return null;
}

/** The overlay with one write root added or removed for `key`, or { error }. */
export function editWriteRoots(overlay, key, op, root) {
  const entry = overlay?.hard?.per_bot?.[key];
  if (!entry || typeof entry !== "object") return { error: `the reviewer overlay has no hard.per_bot.${key}` };
  const roots = entry.allowWriteRoots;
  if (!Array.isArray(roots) || !roots.every((r) => typeof r === "string")) return { error: `hard.per_bot.${key}.allowWriteRoots is not a list of paths` };
  const has = roots.includes(root);
  let next;
  if (op === "add") {
    const problem = writeRootProblem(root);
    if (problem) return { error: problem };
    if (has) return { error: `${root} is a write root already` };
    next = [...roots, root];
  } else {
    if (!has) return { error: `${root} is not a write root` };
    next = roots.filter((r) => r !== root);
    if (!next.length) return { error: "the last write root cannot be removed: an empty list means no write scope at all" };
  }
  const copy = structuredClone(overlay);
  copy.hard.per_bot[key].allowWriteRoots = next;
  return { overlay: copy, roots: next };
}

/**
 * The same merge as scripts/reviewer-policy-merge.py (`make reviewer-policy`),
 * with the same refusals. Its JSON text is the same bytes as the script's:
 * applyAccessEdit checks that on the live files before it writes.
 */
export const GENERATED_NOTE =
  "GENERATED by scripts/reviewer-policy-merge.py — do not edit by hand and do not commit. Edit the private overlay instead.";

export function mergeReviewerPolicy(base, overlay) {
  const merged = {
    _doc: base._doc ?? "",
    _generated: GENERATED_NOTE,
    botAliases: { ...(base.botAliases ?? {}), ...(overlay.botAliases ?? {}) },
  };
  for (const section of ["constitution", "hard"]) {
    const b = base[section] ?? {};
    const o = overlay[section] ?? {};
    merged[section] = { fleet: "fleet" in o ? o.fleet : b.fleet ?? null, per_bot: { ...(b.per_bot ?? {}), ...(o.per_bot ?? {}) } };
    if (merged[section].fleet == null) throw new Error(`neither base nor overlay defines ${section}.fleet`);
  }
  if (!Object.keys(merged.constitution.per_bot).length) throw new Error("the merged policy has zero per-bot entries");
  return merged;
}

export const policyText = (value) => `${JSON.stringify(value, null, 2)}\n`;

// ── files ────────────────────────────────────────────────────────────────────

/** A regular file's text (never through a symlink), or { error }. */
export function readRegular(file, max = 4 * 1024 * 1024) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return { error: `${path.basename(file)} is not a regular file` };
    if (st.size > max) return { error: `${path.basename(file)} is too large` };
    return { text: fs.readFileSync(file, "utf8") };
  } catch (err) {
    return { error: err.code === "ENOENT" ? `${path.basename(file)} is missing` : `${path.basename(file)} does not read` };
  }
}

/** Write in place: the same inode, so a single-file bind mount sees it. */
function writeInPlace(file, text) {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new Error(`${path.basename(file)} is not a regular file`);
  fs.writeFileSync(file, text);
}

export function keepHistory(dir, bot, label, text) {
  const botDir = path.join(dir, bot);
  fs.mkdirSync(botDir, { recursive: true, mode: 0o700 });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`;
  fs.writeFileSync(path.join(botDir, name), text, { mode: 0o600 });
  const all = fs.readdirSync(botDir).sort();
  for (const old of all.slice(0, Math.max(0, all.length - HISTORY_KEEP))) fs.rmSync(path.join(botDir, old));
  return name;
}

/** The host file behind the bot's /app/role.yaml, if it is a bots/ file of this checkout. */
export function roleFileOf(inspect, repoRoot) {
  const m = (inspect?.Mounts ?? []).find((x) => String(x.Destination ?? "").replace(/\/+$/, "") === ROLE_MOUNT);
  if (!m) return { error: "no role.yaml: this bot's tools come from OASIS_TOOLS_ALSO_ALLOW in its compose file (a recreate, step 5 part 2)" };
  const host = String(m.Source ?? "").replace(/^\/host_mnt(?=\/)/, "");
  if (!under(host, path.join(repoRoot, "bots")) || path.basename(host) !== "role.yaml") return { error: `role.yaml comes from ${host}, not from this checkout's bots/ folder` };
  return { file: host };
}

export function policyFiles(repoRoot) {
  return {
    base: path.join(repoRoot, "extensions", "oasis-reviewer", "policy", "reviewer-policy.json"),
    overlay: path.join(repoRoot, "bots", "reviewer-policy.local.json"),
    out: path.join(repoRoot, "bots", ".runtime", "reviewer-policy.json"),
  };
}

/** The three policy files, checked: the overlay in this page's JSON form, and the merged file in sync. */
export function readPolicySet(files) {
  const base = readRegular(files.base);
  const overlay = readRegular(files.overlay);
  const out = readRegular(files.out);
  const error = base.error ?? overlay.error ?? out.error;
  if (error) return { error };
  let parsed;
  try {
    parsed = { base: JSON.parse(base.text), overlay: JSON.parse(overlay.text) };
  } catch {
    return { error: "a reviewer policy file is not valid JSON" };
  }
  if (policyText(parsed.overlay) !== overlay.text) return { error: "reviewer-policy.local.json is not in the JSON form this page writes: edit it by hand" };
  let merged;
  try {
    merged = policyText(mergeReviewerPolicy(parsed.base, parsed.overlay));
  } catch (err) {
    return { error: `the reviewer policy does not merge: ${err.message}` };
  }
  if (merged !== out.text) return { error: "bots/.runtime/reviewer-policy.json is not the merge of the overlay: run make reviewer-policy first" };
  return { ...parsed, overlayText: overlay.text };
}

// ── the edit state (GET /api/access) ─────────────────────────────────────────

/** What the Access view may edit for one bot, read fresh from the host files. */
export function accessEditState({ inspect, repoRoot, files = policyFiles(repoRoot), policySet }) {
  const env = accessEnv(inspect);
  const set = policySet ?? readPolicySet(files);
  const key = policyKey(env.OASIS_AGENT_NAME, set.overlay);
  const perBot = set.overlay?.hard?.per_bot?.[key] ?? null;
  const level = accessLevel(env, perBot?.constitutionalReviewRequired === true);
  const widen = level.id === "C" ? { allowed: false, reason: "no widening for a Level C bot (allowlist exec in the SSH sandbox)" } : { allowed: true, reason: null };

  let tools;
  const role = roleFileOf(inspect, repoRoot);
  if (role.error) tools = { error: role.error };
  else {
    const read = readRegular(role.file, 512 * 1024);
    const parsed = read.error ? read : roleAlsoAllow(read.text);
    tools = parsed.error ? { error: parsed.error, file: path.relative(repoRoot, role.file) } : { file: path.relative(repoRoot, role.file), hash: sha256(read.text), items: parsed.items };
  }

  let writeRoots;
  if (set.error) writeRoots = { error: set.error };
  else if (!perBot) writeRoots = { error: `the reviewer overlay has no hard.per_bot entry for ${key}` };
  else {
    writeRoots = {
      file: path.relative(repoRoot, files.overlay),
      hash: sha256(set.overlayText),
      key,
      roots: Array.isArray(perBot.allowWriteRoots) ? perBot.allowWriteRoots : [],
      // Without denyWriteOutsideAllow the reviewer does not scope writes at all.
      scoped: perBot.denyWriteOutsideAllow === true,
    };
  }
  return { level: level.id, widen, tools, writeRoots };
}

// ── apply one edit ───────────────────────────────────────────────────────────

/** Check that the bot's own PyYAML reads the new role.yaml as intended (runs in the container). */
export function parseRoleInBot(container, text) {
  return new Promise((resolve, reject) => {
    const child = execFile("docker", ["exec", "-i", container, "python3", "-c", ROLE_PY, "/dev/stdin"], { timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(new Error(`the bot's role.yaml parser did not run: ${err.killed ? "timed out" : `exit ${err.code ?? "?"}`}`));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("the bot's role.yaml parser printed no JSON"));
        }
      }
    });
    child.stdin.end(text);
  });
}

/**
 * Plan, sign and apply one edit. `req` = { setting, op, value, baseHash,
 * reason }. `ctx` gives the files, the signers and the history folder.
 * Returns { ok, ... } or { status, error }.
 */
export async function applyAccessEdit(bot, req, ctx) {
  const bad = (error, status = 400) => ({ status, error });
  const { setting, op, value, baseHash } = req ?? {};
  if (!["add", "remove"].includes(op)) return bad("op is add or remove");
  if (typeof baseHash !== "string" || !/^[0-9a-f]{64}$/.test(baseHash)) return bad("baseHash is the hash of the file the page showed");
  const reason = typeof req.reason === "string" ? req.reason.trim().slice(0, 500) : "";
  const files = ctx.files ?? policyFiles(ctx.repoRoot);
  const set = readPolicySet(files);
  const state = accessEditState({ inspect: ctx.inspect, repoRoot: ctx.repoRoot, files, policySet: set });
  const widening = accessWidening({ op });
  if (widening && !state.widen.allowed) return bad(state.widen.reason, 403);

  let file;
  let before;
  let after;
  let write;
  let summary;
  if (setting === "tools.alsoAllow") {
    if (state.tools.error) return bad(state.tools.error, 409);
    if (state.tools.hash !== baseHash) return bad("role.yaml changed since the page read it: reload and try again", 409);
    file = path.join(ctx.repoRoot, state.tools.file);
    const read = readRegular(file, 512 * 1024);
    if (read.error) return bad(read.error, 409);
    const edit = editRoleAlsoAllow(read.text, op, String(value ?? ""));
    if (edit.error) return bad(edit.error, 409);
    if (ctx.running && ctx.parseRole) {
      const parsed = await ctx.parseRole(edit.text);
      const got = parsed?.tools?.alsoAllow ?? null;
      if (!Array.isArray(got) || got.join(",") !== edit.items.join(",")) return bad("the bot's own role.yaml parser does not read the edit as intended: edit role.yaml by hand", 409);
    }
    before = read.text;
    after = edit.text;
    write = () => writeInPlace(file, after);
    summary = `${op === "add" ? "added" : "removed"} the tool ${value}`;
  } else if (setting === "reviewer.writeRoots") {
    if (state.writeRoots.error) return bad(state.writeRoots.error, 409);
    if (state.writeRoots.hash !== baseHash) return bad("reviewer-policy.local.json changed since the page read it: reload and try again", 409);
    const edit = editWriteRoots(set.overlay, state.writeRoots.key, op, String(value ?? ""));
    if (edit.error) return bad(edit.error, 409);
    file = files.overlay;
    before = set.overlayText;
    after = policyText(edit.overlay);
    const merged = policyText(mergeReviewerPolicy(set.base, edit.overlay));
    write = () => {
      writeInPlace(files.overlay, after);
      writeInPlace(files.out, merged);
    };
    summary = `${op === "add" ? "added" : "removed"} the write root ${value}`;
  } else {
    return bad("setting is tools.alsoAllow or reviewer.writeRoots");
  }

  return oneSignature(async () => {
    const auth = loadAuthority(ctx.authorityDir);
    if (!auth.pin) return bad("this Mac has no authority yet: run make authority-init", 409);
    if (!auth.ok) return bad(`the log does not verify: ${streamErrors(auth).join("; ")}`, 409);
    const body = { bot, setting, op, value: String(value), file: path.relative(ctx.repoRoot, file), before: sha256(before), after: sha256(after), ...(reason ? { reason } : {}) };
    let event;
    try {
      const signer = widening ? await ctx.rootSigner() : (ctx.hubSigner ?? loadHubSigner)(ctx.authorityDir);
      event = await appendEvent(ctx.authorityDir, "access", { kind: "access.change", scope: `agent:${bot}`, body }, signer);
    } catch (err) {
      return bad(`not signed: ${err.message}`, err.status ?? 502);
    }
    // Signed: now the file. A file that changed in the meantime is not overwritten.
    const now = readRegular(file);
    if (now.error || now.text !== before) return bad(`signed (${event.id.slice(0, 12)}) but not applied: ${path.basename(file)} changed meanwhile`, 409);
    keepHistory(ctx.historyDir, bot, path.basename(file), before);
    write();
    return {
      ok: true,
      event: { id: event.id, seq: event.seq, at: event.at, signedBy: widening ? "root" : "hub" },
      summary,
      restart: { container: ctx.container, why: setting === "tools.alsoAllow" ? "the boot compiles role.yaml" : "the reviewer reads its policy once per process" },
    };
  });
}
