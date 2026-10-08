// Tests for the observatory settings: USER.md for every bot, the profile, and
// the swarm parameters (Mike, 2026-10-08). Run with:
//   node --test scripts/tests/claw-observatory*.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import {
  checkRequest,
  collectorScript,
  collectUserMd,
  createObservatoryServer,
  identityStore,
  isBlankUserTemplate,
  keepUserMdHistory,
  mergeUserMd,
  renderProfileBlock,
  settingsStore,
  USER_MD_END,
  USER_MD_START,
  validateSettings,
} from "../claw-observatory.mjs";

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// openclaw's blank USER.md, as five of the seven bots still had it.
const TEMPLATE = `# USER.md - About Your Human

_Learn about the person you're helping. Update this as you go._

- **Name:**
- **What to call them:**
- **Pronouns:** _(optional)_
- **Timezone:**
- **Notes:**

## Context

_(What do they care about? What projects are they working on? What annoys them? What makes them laugh? Build this over time.)_

---

The more you know, the better you can help. But remember — you're learning about a person, not building a dossier. Respect the difference.

## Related

- [Agent workspace](/concepts/agent-workspace)
`;

const LEARNED = TEMPLATE.replace("- **Name:**", "- **Name:** Mike Lee").replace(
  /_\(What do they care.*\)_/,
  "- Prefers depth over surface",
);

const PROFILE = { name: "Mike Lee", callThem: "Mike", pronouns: "", timezone: "America/New_York", notes: "Founder of Oasis-X", context: "Builds the fleet." };

/** Run the collector as the container does: stringified, in a fresh context. */
function runUserMd(home, ...args) {
  let out = "";
  const sandbox = {
    require: (name) => ({ fs, path })[name],
    process: { argv: ["node", ...args.map(String)], stdout: { write: (s) => (out += s) } },
    Buffer,
  };
  vm.runInNewContext(collectorScript(collectUserMd, home), sandbox);
  return JSON.parse(out);
}

test("isBlankUserTemplate: the openclaw template is blank; a filled field, a note, or the block is not", () => {
  assert.equal(isBlankUserTemplate(TEMPLATE), true);
  assert.equal(isBlankUserTemplate(LEARNED), false);
  assert.equal(isBlankUserTemplate(TEMPLATE.replace("- **Timezone:**", "- **Timezone:** UTC")), false);
  assert.equal(isBlankUserTemplate(mergeUserMd(TEMPLATE, PROFILE)), false);
  assert.equal(isBlankUserTemplate("some notes"), false);
});

test("mergeUserMd: replaces a blank template, keeps a bot's notes, and replaces only the block after that", () => {
  const fresh = mergeUserMd(TEMPLATE, PROFILE);
  assert.ok(fresh.startsWith("# USER.md - About Your Human\n\n" + USER_MD_START));
  assert.match(fresh, /^- \*\*Name:\*\* Mike Lee$/m);
  assert.match(fresh, /^- \*\*Pronouns:\*\*$/m, "an empty field stays an empty line");
  assert.match(fresh, /### Context\n\nBuilds the fleet\./);
  assert.ok(!fresh.includes("_(What do they care"), "the blank template is gone");

  const kept = mergeUserMd(LEARNED, PROFILE);
  assert.ok(kept.includes("- Prefers depth over surface"), "the bot's own notes stay");
  assert.ok(kept.indexOf(USER_MD_START) < kept.indexOf("- Prefers depth"), "the block goes under the first heading");
  assert.ok(kept.startsWith("# USER.md - About Your Human\n\n" + USER_MD_START));

  // A second apply with a changed profile replaces the block and nothing else.
  const botAdded = kept + "\n- Likes long walks\n";
  const again = mergeUserMd(botAdded, { ...PROFILE, callThem: "Michael" });
  assert.equal(again.split(USER_MD_START).length, 2, "one block only");
  assert.match(again, /What to call them:\*\* Michael$/m);
  assert.ok(again.includes("- Likes long walks") && again.includes("- Prefers depth over surface"));
  assert.equal(again.replace(/<!-- fleet-observatory[\s\S]*?:end -->/, ""), botAdded.replace(/<!-- fleet-observatory[\s\S]*?:end -->/, ""));

  assert.equal(mergeUserMd("", PROFILE), mergeUserMd(TEMPLATE, PROFILE));
  assert.ok(mergeUserMd("no heading here", PROFILE).startsWith(USER_MD_START));
});

test("renderProfileBlock keeps each field on one line", () => {
  const block = renderProfileBlock({ notes: "line one\n\nline two" });
  assert.match(block, /^- \*\*Notes:\*\* line one line two$/m);
  assert.ok(block.startsWith(USER_MD_START) && block.endsWith(USER_MD_END));
});

test("collectUserMd: reads, writes on a matching hash, refuses a stale hash and a symlink", () => {
  const home = tmp("obs-usermd-");
  fs.mkdirSync(path.join(home, "workspace"));
  const missing = runUserMd(home, "read");
  assert.deepEqual([missing.exists, missing.hash], [false, "missing"]);

  const b64 = (t) => Buffer.from(t, "utf8").toString("base64");
  const first = runUserMd(home, "write", "missing", b64(TEMPLATE));
  assert.equal(first.written, true);
  assert.equal(fs.readFileSync(path.join(home, "workspace", "USER.md"), "utf8"), TEMPLATE);
  assert.match(first.hash, /^[0-9a-f]{16}$/);

  const stale = runUserMd(home, "write", "missing", b64("x"));
  assert.equal(stale.conflict, true, "the file exists now, so 'missing' is stale");
  assert.equal(fs.readFileSync(path.join(home, "workspace", "USER.md"), "utf8"), TEMPLATE);

  const ok = runUserMd(home, "write", first.hash, b64("café ✓"));
  assert.equal(ok.text, "café ✓", "UTF-8 survives the base64 trip");
  assert.notEqual(ok.hash, first.hash);
  assert.deepEqual(fs.readdirSync(path.join(home, "workspace")), ["USER.md"], "no temp file left");

  assert.match(runUserMd(home, "write", ok.hash, b64("y".repeat(16001))).error, /longer than 16000/);

  const outside = path.join(home, "outside.md");
  fs.writeFileSync(outside, "secret");
  fs.rmSync(path.join(home, "workspace", "USER.md"));
  fs.symlinkSync(outside, path.join(home, "workspace", "USER.md"));
  assert.match(runUserMd(home, "read").error, /not a regular file/);
  assert.match(runUserMd(home, "write", "missing", b64("z")).error, /not a regular file/);
  assert.equal(fs.readFileSync(outside, "utf8"), "secret", "a symlink is never followed");
});

test("validateSettings takes only the profile fields and finite swarm numbers", () => {
  assert.deepEqual(validateSettings({ profile: { name: "Mike" }, swarm: { LINK_K: 4 } }), { profile: { name: "Mike" }, swarm: { LINK_K: 4 } });
  assert.deepEqual(validateSettings({ swarm: null }), { swarm: {} });
  for (const bad of [null, [], { other: 1 }, { profile: { evil: "x" } }, { profile: { name: 3 } }, { profile: { name: "x".repeat(401) } }, { swarm: { link_k: 1 } }, { swarm: { LINK_K: "4" } }, { swarm: { LINK_K: Infinity } }, { swarm: [] }]) {
    assert.throws(() => validateSettings(bad), (err) => err.status === 400, JSON.stringify(bad));
  }
  assert.equal(validateSettings({ profile: { context: "c".repeat(8000) } }).profile.context.length, 8000);
});

test("settingsStore merges, keeps mode 600; keepUserMdHistory keeps the newest 30", () => {
  const dir = tmp("obs-settings-");
  const store = settingsStore(path.join(dir, "settings.json"));
  assert.deepEqual(store.read(), { profile: {}, swarm: {}, updatedAt: null });
  store.update({ profile: { name: "Mike" } });
  const after = store.update({ swarm: { LINK_K: 2 } });
  assert.deepEqual([after.profile, after.swarm], [{ name: "Mike" }, { LINK_K: 2 }]);
  assert.equal(fs.statSync(path.join(dir, "settings.json")).mode & 0o777, 0o600);

  const hist = path.join(dir, "hist");
  fs.mkdirSync(path.join(hist, "house"), { recursive: true });
  for (let i = 0; i < 31; i++) fs.writeFileSync(path.join(hist, "house", `2026-01-01T00-00-${String(i).padStart(2, "0")}.md`), "old");
  const name = keepUserMdHistory(hist, "house", "latest");
  const kept = fs.readdirSync(path.join(hist, "house")).sort();
  assert.equal(kept.length, 30);
  assert.ok(kept.includes(name));
  assert.equal(fs.readFileSync(path.join(hist, "house", name), "utf8"), "latest");
});

test("checkRequest admits PUT to the settings and to one bot's USER.md only", () => {
  const port = 18780;
  const req = (method, url) => ({ method, url, headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` } });
  assert.equal(checkRequest(req("PUT", "/api/settings"), port), null);
  assert.equal(checkRequest(req("PUT", "/api/user-md/house"), port), null);
  assert.equal(checkRequest(req("POST", "/api/settings"), port).status, 405);
  assert.equal(checkRequest(req("PUT", "/api/user-md"), port).status, 405);
  assert.equal(checkRequest(req("PUT", "/api/user-md/house/preview"), port).status, 405);
  assert.equal(checkRequest(req("DELETE", "/api/user-md/house"), port).status, 405);
  const noOrigin = req("PUT", "/api/settings");
  delete noOrigin.headers.origin;
  assert.equal(checkRequest(noOrigin, port).status, 403);
});

test("server: settings round trip; USER.md list, preview, write with history, stale write refused", async () => {
  const files = { house: { text: TEMPLATE }, kolmogorov: { text: LEARNED } };
  const hashOf = (t) => `h${String(t.length).padStart(15, "0")}`.replace("h", "a");
  const view = (key) => {
    const f = files[key];
    return { exists: true, text: f.text, hash: hashOf(f.text), size: f.text.length, mtimeMs: 1 };
  };
  const history = [];
  const ctx = {
    port: 0,
    token: "t".repeat(43),
    discover: async () => ({
      bots: [
        { key: "house", container: "oasis-claw-house", running: true, state: "running", controlUi: { url: null, via: "none" }, board: null },
        { key: "kolmogorov", container: "oasis-claw-kolmogorov", running: true, state: "running", controlUi: { url: null, via: "none" }, board: null },
        { key: "down", container: "oasis-claw-down", running: false, state: "exited", controlUi: { url: null, via: "none" }, board: null },
      ],
      proxy: null,
    }),
    swarm: { port: 1, url: "http://127.0.0.1:1/" },
    snapshotDir: tmp("obs-empty-"),
    mailRoot: tmp("obs-mail-empty-"),
    identities: identityStore(tmp("obs-ident-")),
    readIdentity: async () => ({ name: null, role: null, avatar: null }),
    settings: settingsStore(path.join(tmp("obs-set-"), "settings.json")),
    readUserMd: async (bot) => view(bot.key),
    writeUserMd: async (bot, baseHash, text) => {
      if (baseHash !== hashOf(files[bot.key].text)) return { conflict: true, ...view(bot.key) };
      files[bot.key].text = text;
      return { written: true, ...view(bot.key) };
    },
    keepUserMdHistory: (key, text) => history.push([key, text]),
  };
  const server = createObservatoryServer(ctx);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  ctx.port = server.address().port;
  const own = `http://127.0.0.1:${ctx.port}`;
  const call = (pathname, { method = "GET", body, origin = own, token = ctx.token } = {}) =>
    new Promise((resolve, reject) => {
      const headers = { host: `127.0.0.1:${ctx.port}`, "x-observatory-token": token };
      if (method !== "GET") headers.origin = origin;
      if (body !== undefined) headers["content-type"] = "application/json";
      const r = http.request({ host: "127.0.0.1", port: ctx.port, path: pathname, method, headers, agent: false }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(text || "null") }));
      });
      r.on("error", reject);
      r.end(body);
    });
  try {
    assert.equal((await call("/api/settings", { token: "x" })).status, 401);
    assert.equal((await call("/api/settings", { method: "PUT", body: JSON.stringify({ profile: { name: 1 } }) })).status, 400);
    assert.equal((await call("/api/settings", { method: "PUT", body: "{" })).status, 400);
    assert.equal((await call("/api/settings", { method: "PUT", body: JSON.stringify({ profile: PROFILE }), origin: "http://127.0.0.1:18890" })).status, 403);
    const saved = await call("/api/settings", { method: "PUT", body: JSON.stringify({ profile: PROFILE, swarm: { LINK_K: 2 } }) });
    assert.equal(saved.status, 200);
    assert.deepEqual((await call("/api/settings")).json.swarm, { LINK_K: 2 });

    const list = await call("/api/user-md");
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.profile, PROFILE);
    assert.deepEqual(list.json.bots.map((b) => [b.key, Boolean(b.text), b.error ?? null]), [
      ["house", true, null],
      ["kolmogorov", true, null],
      ["down", false, "oasis-claw-down is exited"],
    ]);

    const preview = await call("/api/user-md/kolmogorov/preview");
    assert.equal(preview.status, 200);
    assert.equal(preview.json.text, mergeUserMd(LEARNED, PROFILE));
    assert.equal(preview.json.baseHash, hashOf(LEARNED));
    assert.equal(files.kolmogorov.text, LEARNED, "a preview writes nothing");

    const write = await call("/api/user-md/kolmogorov", { method: "PUT", body: JSON.stringify({ text: preview.json.text, baseHash: preview.json.baseHash }) });
    assert.equal(write.status, 200);
    assert.equal(files.kolmogorov.text, preview.json.text);
    assert.deepEqual(history, [["kolmogorov", LEARNED]], "the replaced text is kept");

    const stale = await call("/api/user-md/kolmogorov", { method: "PUT", body: JSON.stringify({ text: "x", baseHash: preview.json.baseHash }) });
    assert.equal(stale.status, 409);
    assert.match(stale.json.error, /changed its USER\.md/);
    assert.equal(files.kolmogorov.text, preview.json.text);
    assert.equal(history.length, 1);

    assert.equal((await call("/api/user-md/kolmogorov", { method: "PUT", body: JSON.stringify({ text: "x", baseHash: "nope" }) })).status, 400);
    assert.equal((await call("/api/user-md/kolmogorov", { method: "PUT", body: JSON.stringify({ text: "x".repeat(16001), baseHash: hashOf(files.kolmogorov.text) }) })).status, 413);
    assert.equal((await call("/api/user-md/down", { method: "PUT", body: JSON.stringify({ text: "x", baseHash: "missing" }) })).status, 409);
    assert.equal((await call("/api/user-md/nobody/preview")).status, 404);
    assert.equal((await call("/api/user-md/house", { method: "PUT", body: JSON.stringify({ text: "x", baseHash: hashOf(TEMPLATE) }), origin: "http://evil.test" })).status, 403);
    assert.equal(files.house.text, TEMPLATE);
  } finally {
    server.close();
  }
});
