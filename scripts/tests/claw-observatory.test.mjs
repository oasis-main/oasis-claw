// Tests for the CLAW-108 observatory.
//
// Load-bearing properties:
//   1. The in-container collectors are self-contained (they are stringified
//      and run with `node -e`), and they never emit the device private key or
//      a gateway token.
//   2. The snapshot writes and removes only allowlisted paths, whatever the
//      payload claims.
//   3. The HTTP server refuses a foreign Host, a foreign Origin, any write
//      outside /api/feedback, a write without this page's Origin, and any API
//      call without the per-run token. (The feedback routes themselves are
//      tested in claw-observatory-feedback.test.mjs.)

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  BOT_HOME,
  boardSummary,
  cached,
  checkRequest,
  collectIdentity,
  collectProfile,
  collectSessions,
  collectSnapshot,
  collectTranscript,
  collectorScript,
  controlUiFor,
  createObservatoryServer,
  declaredPort,
  describeBot,
  ensureKey,
  identityStore,
  hostPathFor,
  isSnapshotPath,
  mailSummary,
  parseFlags,
  parseHealth,
  parseHistoryLog,
  parseProxyRoutes,
  parseRoleYaml,
  planProxyRoutes,
  renderIcon,
  renderProxyRoutesOverride,
  roleFamily,
  rotateKey,
  runSnapshot,
  sniffImage,
  ensureProxyKey,
  tokenMatches,
  withOpenUrls,
  writeBotSnapshot,
} from "../claw-observatory.mjs";

const SESSION_A = "aaaaaaaa-1111-2222-3333-444444444444";
const SESSION_B = "bbbbbbbb-1111-2222-3333-444444444444";

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAt(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function makeHome() {
  const home = tmp("obs-home-");
  const now = Date.now();
  const w = (rel, content) => writeAt(home, rel, content);
  w(
    "openclaw.json",
    JSON.stringify({
      agents: { defaults: { model: { primary: "prov/model-a" } } },
      plugins: { entries: { "memory-core": { config: { dreaming: { frequency: "40 22 * * *", timezone: "America/New_York" } } } } },
      gateway: { auth: { token: "SECRET-GATEWAY-TOKEN" } },
    }),
  );
  w("identity/device.json", JSON.stringify({ createdAtMs: 1783474717335, privateKeyPem: "-----BEGIN PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END PRIVATE KEY-----" }));
  w("workspace/IDENTITY.md", "# Identity\n- **Name:** Test Bot\n");
  w("workspace/SOUL.md", "be kind\n");
  w("workspace/MEMORY.md", "remember this\n");
  w("workspace/DREAMS.md", `${"x".repeat(50_000)}LATEST DREAM`);
  w("workspace/secret-work.md", "a root file outside the allowlist\n");
  w("workspace/memory/2026-09-14.md", "daily note\n");
  w("workspace/memory/topic.md", "topic note\n");
  w("workspace/memory/dreaming/deep/2026-09-14.md", "deep dream\n");
  fs.symlinkSync("/etc/hosts", path.join(home, "workspace", "memory", "linked.md"));
  w(
    "workspace/memory/.dreams/events.jsonl",
    [
      { type: "memory.promotion.applied", timestamp: "2026-09-15T03:08:00Z", applied: 2, candidates: 5 },
      { type: "memory.dream.completed", phase: "deep", timestamp: "2026-09-15T03:09:00Z", lineCount: 10 },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
  w(
    "logs/reviewer/reviewer-audit.jsonl",
    `${[
      { ts: new Date(now - 3 * 86_400_000).toISOString(), verdict: "escalate", toolName: "write" },
      { ts: new Date(now - 7_200_000).toISOString(), verdict: "deny", toolName: "exec", principle: "p1", reason: "no" },
      { ts: new Date(now - 3_600_000).toISOString(), verdict: "allow", toolName: "exec" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n")}\n`,
  );
  w(
    "agents/main/sessions/sessions.json",
    JSON.stringify({
      "agent:main:main": { sessionId: SESSION_A, updatedAt: now - 1000, model: "m", totalTokens: 10 },
      [`agent:main:subagent:${SESSION_B}`]: { sessionId: SESSION_B, updatedAt: now - 5000 },
      "agent:main:main:heartbeat": { sessionId: "cccccccc-1111-2222-3333-444444444444", updatedAt: now - 9000 },
      "agent:main:cron:x:run:y": { sessionId: "../../etc/passwd", updatedAt: now },
      "agent:main:telegram:direct:123456789": { sessionId: "dddddddd-1111-2222-3333-444444444444", updatedAt: now - 20000 },
      "agent:main:dreaming-narrative-deep-c17d12345c1": { sessionId: "eeeeeeee-1111-2222-3333-444444444444", updatedAt: now - 30000 },
    }),
  );
  w(
    `agents/main/sessions/${SESSION_A}.jsonl`,
    `${[
      { type: "session", id: "s" },
      { type: "model_change", timestamp: "2026-09-15T00:00:00Z" },
      { type: "message", timestamp: "2026-09-15T00:00:01Z", message: { role: "user", content: "hello" } },
      {
        type: "message",
        timestamp: "2026-09-15T00:00:02Z",
        message: {
          role: "assistant",
          model: "m",
          content: [
            { type: "thinking", thinking: "let me think", thinkingSignature: "sig" },
            { type: "toolCall", id: "t1", name: "exec", arguments: { cmd: "ls" } },
          ],
        },
      },
      { type: "message", timestamp: "2026-09-15T00:00:03Z", message: { role: "toolResult", toolName: "exec", isError: false, content: [{ type: "text", text: "file.txt" }] } },
      { type: "message", timestamp: "2026-09-15T00:00:04Z", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n")}\n`,
  );
  return home;
}

/** Run a collector the way the container does: as stringified source, in a
 *  fresh context that has no access to this module's scope. */
function runCollector(fn, home, ...args) {
  let out = "";
  const sandbox = {
    require: (name) => ({ fs, path })[name],
    process: { argv: ["node", ...args.map(String)], stdout: { write: (s) => (out += s) } },
    Buffer,
  };
  vm.runInNewContext(collectorScript(fn, home), sandbox);
  return { raw: out, value: JSON.parse(out) };
}

test("collectorScript embeds the container home by default", () => {
  assert.match(collectorScript(collectSessions), new RegExp(JSON.stringify(BOT_HOME).replace(/[.]/g, "\\.")));
});

test("profile collector: identity, age, model, dreams, reviewer — and no secrets", () => {
  const home = makeHome();
  const { raw, value: p } = runCollector(collectProfile, home);
  assert.equal(p.name, "Test Bot");
  assert.equal(p.createdAtMs, 1783474717335);
  assert.equal(p.model, "prov/model-a");
  assert.equal(p.dreaming.frequency, "40 22 * * *");
  assert.equal(p.docs.memory.text, "remember this\n");
  assert.equal(p.docs.dreams.mode, "tail");
  assert.ok(p.docs.dreams.text.endsWith("LATEST DREAM"));
  assert.ok(p.docs.dreams.truncated > 0);
  assert.equal(p.phases.deep.count, 1);
  assert.equal(p.phases.light.count, 0);
  assert.deepEqual(p.notes.daily.map((n) => n.name), ["2026-09-14.md"]);
  assert.deepEqual(p.notes.topics.map((n) => n.name), ["topic.md"], "the symlinked note is not listed");
  assert.equal(p.reviewer.window24h.allow, 1);
  assert.equal(p.reviewer.window24h.deny, 1);
  assert.equal(p.reviewer.window7d.escalate, 1);
  assert.deepEqual(p.reviewer.recent.map((r) => r.verdict), ["deny", "escalate"]);
  assert.equal(p.dreamEvents.promotions, 1);
  assert.equal(p.dreamEvents.lastDream.deep.lineCount, 10);
  assert.ok(!raw.includes("SECRETKEYMATERIAL"), "device private key leaked");
  assert.ok(!raw.includes("SECRET-GATEWAY-TOKEN"), "gateway token leaked");
});

test("sessions collector: kinds, order, and a hostile sessionId", () => {
  const home = makeHome();
  const { value } = runCollector(collectSessions, home);
  const byKey = Object.fromEntries(value.sessions.map((s) => [s.key, s]));
  assert.equal(byKey["agent:main:main"].kind, "main");
  assert.equal(byKey[`agent:main:subagent:${SESSION_B}`].kind, "subagent");
  assert.equal(byKey["agent:main:main:heartbeat"].kind, "heartbeat");
  assert.equal(byKey["agent:main:cron:x:run:y"].kind, "cron");
  assert.equal(byKey["agent:main:cron:x:run:y"].sessionId, null);
  assert.equal(byKey["agent:main:telegram:direct:123456789"].kind, "chat");
  assert.equal(byKey["agent:main:dreaming-narrative-deep-c17d12345c1"].kind, "dream");
  assert.ok(byKey["agent:main:main"].transcript.size > 0);
  assert.equal(byKey[`agent:main:subagent:${SESSION_B}`].transcript, null);
  const times = value.sessions.map((s) => s.updatedAt);
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test("transcript collector: thinking, tool calls, results, events, limit", () => {
  const home = makeHome();
  const { value } = runCollector(collectTranscript, home, "main", SESSION_A, "50");
  assert.deepEqual(
    value.entries.map((e) => e.event ?? e.role),
    ["model_change", "user", "assistant", "toolResult", "assistant"],
  );
  const assistant = value.entries[2];
  assert.deepEqual(assistant.parts.map((p) => p.t), ["thinking", "call"]);
  assert.equal(assistant.parts[0].text, "let me think");
  assert.equal(assistant.parts[1].name, "exec");
  assert.match(assistant.parts[1].args, /"cmd": "ls"/);
  assert.equal(value.entries[3].toolName, "exec");
  assert.equal(runCollector(collectTranscript, home, "main", SESSION_A, "2").value.entries.length, 2);
  assert.equal(runCollector(collectTranscript, home, "main", "../../etc", "5").value.error, "invalid session id");
  assert.equal(runCollector(collectTranscript, home, "../x", SESSION_A, "5").value.error, "invalid session id");
});

test("snapshot collector: allowlisted files only, symlink skipped, no secrets", () => {
  const home = makeHome();
  const { raw, value } = runCollector(collectSnapshot, home);
  assert.deepEqual(Object.keys(value.files).sort(), [
    "DREAMS.md",
    "IDENTITY.md",
    "MEMORY.md",
    "SOUL.md",
    "memory/2026-09-14.md",
    "memory/dreaming/deep/2026-09-14.md",
    "memory/topic.md",
  ]);
  assert.deepEqual(value.skipped, [{ file: "memory/linked.md", why: "not a regular file" }]);
  assert.deepEqual(value.meta, { name: "Test Bot", createdAtMs: 1783474717335, model: "prov/model-a", dreaming: "40 22 * * *" });
  assert.ok(!raw.includes("SECRETKEYMATERIAL"));
  assert.ok(!raw.includes("SECRET-GATEWAY-TOKEN"));
});

test("isSnapshotPath accepts the allowlist and nothing else", () => {
  for (const ok of ["MEMORY.md", "SOUL.md", "memory/2026-09-14.md", "memory/dreaming/rem/2026-09-14.md"]) {
    assert.ok(isSnapshotPath(ok), ok);
  }
  for (const bad of ["../MEMORY.md", "memory/../SOUL.md", "identity/device.json", "openclaw.json", "notes.md", "memory/.hidden.md", "memory/dreaming/other/x.md", "memory/a/b.md", "/etc/passwd"]) {
    assert.ok(!isSnapshotPath(bad), bad);
  }
});

test("writeBotSnapshot writes, ignores hostile paths, is idempotent, removes stale files", () => {
  const dir = tmp("obs-bot-");
  const first = writeBotSnapshot(dir, {
    files: { "MEMORY.md": "one\n", "memory/2026-09-14.md": "note\n", "../evil.md": "x", "identity/device.json": "{}" },
    meta: { name: "B", createdAtMs: 1 },
  });
  assert.deepEqual(first.written.sort(), ["MEMORY.md", "memory/2026-09-14.md", "meta.json"]);
  assert.deepEqual(first.ignored.sort(), ["../evil.md", "identity/device.json"]);
  assert.ok(!fs.existsSync(path.join(path.dirname(dir), "evil.md")));
  const again = writeBotSnapshot(dir, { files: { "MEMORY.md": "one\n", "memory/2026-09-14.md": "note\n" }, meta: { name: "B", createdAtMs: 1 } });
  assert.deepEqual(again, { written: [], removed: [], ignored: [] });
  writeAt(dir, "operator-note.txt", "not ours");
  const third = writeBotSnapshot(dir, { files: { "MEMORY.md": "two\n" }, meta: { name: "B", createdAtMs: 1 } });
  assert.deepEqual(third.written, ["MEMORY.md"]);
  assert.deepEqual(third.removed, ["memory/2026-09-14.md"]);
  assert.ok(fs.existsSync(path.join(dir, "operator-note.txt")), "a file outside the allowlist is never removed");
});

test("runSnapshot commits a change, skips an unchanged night, and names what it did not read", async () => {
  const dir = path.join(tmp("obs-snap-"), "snapshots");
  const bots = [
    { key: "house", container: "oasis-claw-house", running: true, excluded: false, state: "running" },
    { key: "kaizen", container: "oasis-claw-kaizen", running: true, excluded: true, state: "running" },
    { key: "claptrap", container: "oasis-claw-claptrap", running: false, excluded: false, state: "exited" },
  ];
  let memory = "night one\n";
  const opts = {
    dir,
    log: () => {},
    discover: async () => ({ bots, proxy: null }),
    collectFn: async (bot) => {
      assert.equal(bot.key, "house", "only running, non-excluded bots are read");
      return { files: { "MEMORY.md": memory }, skipped: [], meta: { name: "Mr. House" } };
    },
  };
  const one = await runSnapshot(opts);
  assert.ok(one.committed);
  assert.deepEqual(one.skippedBots, ["kaizen (excluded)", "claptrap (exited)"]);
  assert.equal((await runSnapshot(opts)).committed, null);
  memory = "night two\n";
  const three = await runSnapshot(opts);
  assert.ok(three.committed);
  const log = execFileSync("git", ["-C", dir, "log", "--format=%s", "--", "house/MEMORY.md"], { encoding: "utf8" });
  assert.equal(log.trim().split("\n").length, 2);
  const mode = fs.statSync(dir).mode & 0o777;
  assert.equal(mode, 0o700);
});

test("hostPathFor: longest bind wins, host_mnt prefix is dropped, prefix boundary holds", () => {
  const mounts = [
    { Type: "bind", Source: "/host_mnt/Users/m/Documents/Runes/oasis-x", Destination: "/reach/oasis-x" },
    { Type: "bind", Source: "/host_mnt/Users/m/Documents/Runes/.reach-empty-shield", Destination: "/reach/oasis-x/oasis-claw" },
    { Type: "volume", Name: "v", Source: "/var/lib/docker/volumes/v/_data", Destination: "/home/node/.openclaw" },
  ];
  assert.equal(hostPathFor(mounts, "/reach/oasis-x/.swarm"), "/Users/m/Documents/Runes/oasis-x/.swarm");
  assert.equal(hostPathFor(mounts, "/reach/oasis-x/oasis-claw/.swarm"), "/Users/m/Documents/Runes/.reach-empty-shield/.swarm");
  assert.equal(hostPathFor(mounts, "/reach/oasis-xyz/.swarm"), null);
  assert.equal(hostPathFor(mounts, "/home/node/.openclaw/workspace"), null, "volumes have no host path");
});

test("controlUiFor: direct on 18789, proxy by container or host publish, otherwise why not", () => {
  const routes = [
    { listenPort: 18891, targetHost: "oasis-claw-house", targetPort: 18789, hostPort: 18891 },
    { listenPort: 18896, targetHost: "host.docker.internal", targetPort: 18796, hostPort: 18896 },
  ];
  assert.deepEqual(controlUiFor({ container: "oasis-claw-runtime", hostPort: 18789 }, routes), { url: "http://127.0.0.1:18789/", via: "direct" });
  assert.deepEqual(controlUiFor({ container: "oasis-claw-house", hostPort: null }, routes), { url: "http://127.0.0.1:18891/", via: "proxy" });
  assert.deepEqual(controlUiFor({ container: "oasis-claw-hello-world", hostPort: 18796 }, routes), { url: "http://127.0.0.1:18896/", via: "proxy" });
  assert.deepEqual(controlUiFor({ container: "oasis-claw-yesman", hostPort: null }, []), { url: null, via: "unpublished" });
  assert.deepEqual(controlUiFor({ container: "oasis-claw-hello-world", hostPort: 18796 }, []), { url: null, via: "origin-mismatch" });
});

test("describeBot: key from the mailbox mount, board mapped to the host, corporate bot excluded", () => {
  const inspect = (name, extraMounts = [], env = []) => ({
    Name: `/${name}`,
    State: { Status: "running", Health: { Status: "healthy" } },
    Config: { Env: env },
    NetworkSettings: { Networks: { "oasis-claw_oasis_runtime": {} }, Ports: { "18789/tcp": [{ HostIp: "127.0.0.1", HostPort: "18789" }] } },
    Mounts: [{ Type: "volume", Name: "home", Destination: BOT_HOME }, ...extraMounts],
  });
  const nimbus = describeBot(
    inspect(
      "oasis-claw-runtime",
      [
        { Type: "bind", Source: "/Users/m/Documents/Runes/.claw-mail/nimbus/inbox", Destination: "/reach/mail/inbox" },
        { Type: "bind", Source: "/host_mnt/Users/m/Documents/Nimbus", Destination: "/reach/nimbus" },
      ],
      ["OASIS_AGENT_NAME=Nimbus", "OASIS_SWARM_DIR=/reach/nimbus/personal/.swarm"],
    ),
    [],
  );
  assert.equal(nimbus.key, "nimbus");
  assert.equal(nimbus.mailbox, "nimbus");
  assert.equal(nimbus.agentName, "Nimbus");
  assert.equal(nimbus.board.hostPath, "/Users/m/Documents/Nimbus/personal/.swarm");
  assert.equal(nimbus.controlUi.via, "direct");
  assert.equal(describeBot(inspect("oasis-claw-house", [], ["OASIS_AGENT_NAME=Mr. House"]), []).key, "house");
  assert.equal(describeBot(inspect("oasis-claw-kaizen"), []).excluded, true);
  assert.equal(describeBot({ ...inspect("oasis-claw-vet"), Mounts: [] }, []), null, "a container without a bot home is not a bot");
  assert.equal(describeBot(inspect("other-container"), []), null);
});

test("parseHealth reads the health from docker ps Status", () => {
  assert.equal(parseHealth("Up 13 minutes (healthy)"), "healthy");
  assert.equal(parseHealth("Up 2 hours (unhealthy)"), "unhealthy");
  assert.equal(parseHealth("Up 5 seconds (health: starting)"), "starting");
  assert.equal(parseHealth("Up 2 hours"), null);
  assert.equal(parseHealth("Exited (0) 3 hours ago"), null);
});

test("parseProxyRoutes reads the proxy's ROUTES env", () => {
  assert.deepEqual(parseProxyRoutes("18891=oasis-claw-house:18789, 18896=host.docker.internal:18796, junk"), [
    { listenPort: 18891, targetHost: "oasis-claw-house", targetPort: 18789 },
    { listenPort: 18896, targetHost: "host.docker.internal", targetPort: 18796 },
  ]);
});

test("boardSummary counts item states and lists open items outside Done", () => {
  const swarm = tmp("obs-swarm-");
  writeAt(
    swarm,
    "queue.md",
    [
      "# Queue",
      "## Active",
      "- [ ] [CLAW-108] [OPEN] **Observatory** build",
      "- [/] [CLAW-106] half done",
      "- [!] [CLAW-050] blocked thing",
      "## Done (recent)",
      "- [x] [CLAW-090] shipped",
      "- [ ] [CLAW-001] stray open item under Done",
    ].join("\n"),
  );
  writeAt(swarm, "state.md", "# State\n");
  const s = boardSummary(swarm);
  assert.deepEqual(s.counts, { open: 2, "in progress": 1, blocked: 1, done: 1 });
  assert.deepEqual(s.open.map((i) => i.id), ["CLAW-108", "CLAW-106", "CLAW-050"]);
  assert.equal(s.open[0].title, "[OPEN] Observatory build");
  assert.ok(s.stateUpdatedMs > 0);
  assert.match(boardSummary(path.join(swarm, "missing")).error, /not readable/);
});

test("mailSummary counts per peer in both directions", () => {
  const root = tmp("obs-mail-");
  writeAt(root, "house/inbox/a.json", JSON.stringify({ from: "kolmogorov", to: ["house"], ts: "2026-09-01T00:00:00Z" }));
  writeAt(root, "house/archive/b.json", JSON.stringify({ from: "kolmogorov", to: ["house"], ts: "2026-09-02T00:00:00Z" }));
  writeAt(root, "house/sent/c.json", JSON.stringify({ from: "house", to: ["kolmogorov", "yesman"], ts: "2026-09-03T00:00:00Z" }));
  writeAt(root, "house/inbox/broken.json", "{not json");
  assert.deepEqual(mailSummary(root, "house"), {
    peers: { kolmogorov: { received: 2, sent: 1 }, yesman: { received: 0, sent: 1 } },
    total: 4,
    last: "2026-09-03T00:00:00Z",
  });
  assert.equal(mailSummary(root, "../etc"), null);
  assert.equal(mailSummary(root, "nobody"), null);
});

test("parseHistoryLog keeps only this bot's files", () => {
  const sha = "a".repeat(40);
  const out = `\x1e${sha}\x1f2026-09-15T23:55:00-04:00\x1fsnapshot X\n\n3\t1\thouse/MEMORY.md\n1\t0\tnimbus/MEMORY.md\n-\t-\thouse/memory/x.md\n`;
  assert.deepEqual(parseHistoryLog(out, "house/"), [
    {
      sha,
      date: "2026-09-15T23:55:00-04:00",
      subject: "snapshot X",
      files: [
        { file: "MEMORY.md", added: 3, deleted: 1 },
        { file: "memory/x.md", added: null, deleted: null },
      ],
    },
  ]);
});

test("withOpenUrls sends only a proxied UI through the unlock page", () => {
  const fleet = {
    bots: [
      { key: "house", controlUi: { url: "http://127.0.0.1:18891/", via: "proxy" } },
      { key: "nimbus", controlUi: { url: "http://127.0.0.1:18789/", via: "direct" } },
      { key: "yesman", controlUi: { url: null, via: "unpublished" } },
    ],
  };
  const key = "k".repeat(43);
  assert.deepEqual(
    withOpenUrls(fleet, key).bots.map((b) => b.controlUi.openUrl),
    [`http://127.0.0.1:18891/__claw-proxy/unlock#k=${key}`, "http://127.0.0.1:18789/", null],
  );
  assert.equal(withOpenUrls(fleet, null).bots[0].controlUi.openUrl, "http://127.0.0.1:18891/");
});

test("ensureProxyKey creates a mode-600 key once, then reuses it", () => {
  const file = path.join(tmp("obs-key-"), "state", "proxy-key");
  const key = ensureProxyKey(file);
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(ensureProxyKey(file), key);
});

test("cached shares a read still in flight past its TTL, expires a settled one, drops a failed one", async () => {
  const ctx = { cache: new Map() };
  let calls = 0;
  const slow = () => new Promise((resolve) => setTimeout(() => resolve(++calls), 80));
  const first = cached(ctx, "k", 10, slow);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(cached(ctx, "k", 10, slow), first, "past the TTL but still in flight: shared");
  assert.equal(await first, 1);
  assert.equal(await cached(ctx, "k", 1000, slow), 1, "settled and inside the TTL: shared");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await cached(ctx, "k", 10, slow), 2, "settled and past the TTL: read again");
  await assert.rejects(cached(ctx, "x", 1000, () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(ctx.cache.has("x"), false);
});

test("checkRequest and tokenMatches", () => {
  const req = (headers, method = "GET", url = "/api/fleet") => ({ headers, method, url });
  const own = { host: "127.0.0.1:18780", origin: "http://127.0.0.1:18780" };
  assert.equal(checkRequest(req({ host: "127.0.0.1:18780" }), 18780), null);
  assert.equal(checkRequest(req({ host: "localhost:18780", origin: "http://localhost:18780" }), 18780), null);
  assert.equal(checkRequest(req({ host: "host.docker.internal:18780" }), 18780).status, 421);
  assert.equal(checkRequest(req({ host: "127.0.0.1:18780", origin: "https://evil.example" }), 18780).status, 403);
  assert.equal(checkRequest(req({ host: "127.0.0.1:18780" }, "POST"), 18780).status, 405);
  assert.equal(checkRequest(req(own, "POST"), 18780).status, 405, "writes only under /api/feedback");
  assert.equal(checkRequest(req(own, "POST", "/api/feedbackx"), 18780).status, 405);
  assert.equal(checkRequest(req(own, "PATCH", "/api/feedback/x"), 18780).status, 405);
  assert.equal(checkRequest(req(own, "POST", "/api/feedback?x=1"), 18780), null);
  assert.equal(checkRequest(req(own, "PUT", "/api/feedback/id/files/1"), 18780), null);
  assert.equal(checkRequest(req(own, "DELETE", "/api/feedback/id"), 18780), null);
  assert.equal(checkRequest(req({ host: own.host }, "POST", "/api/feedback"), 18780).status, 403, "a write needs Origin");
  assert.equal(checkRequest(req({ ...own, origin: "http://127.0.0.1:18891" }, "POST", "/api/feedback"), 18780).status, 403);
  assert.ok(tokenMatches(req({ "x-observatory-token": "abc" }), "abc"));
  assert.ok(!tokenMatches(req({ "x-observatory-token": "abd" }), "abc"));
  assert.ok(!tokenMatches(req({}), "abc"));
});

test("parseFlags", () => {
  assert.deepEqual(parseFlags(["house", "--approve", "req-1", "--json"]), { _: ["house"], approve: "req-1", json: true });
  assert.throws(() => parseFlags(["--port", "0"]), /port/);
  assert.throws(() => parseFlags(["--bogus"]), /unknown option/);
});

test("server: page carries CSP, API needs the token, hostile requests are refused", async () => {
  const ctx = {
    port: 0,
    token: "t".repeat(43),
    discover: async () => ({
      bots: [{ key: "house", container: "oasis-claw-house", running: true, state: "running", controlUi: { url: "http://127.0.0.1:18891/", via: "proxy" }, board: null }],
      proxy: null,
    }),
    swarm: { port: 1, url: "http://127.0.0.1:1/" },
    snapshotDir: tmp("obs-empty-"),
    mailRoot: tmp("obs-mail-empty-"),
    proxyKey: () => "k".repeat(43),
    identities: identityStore(tmp("obs-ident-")),
    readIdentity: async () => ({ name: "Mr. House", emoji: "🎰", creature: "a financier", role: "market-analysis-and-trading-infrastructure", avatar: null }),
  };
  const server = createObservatoryServer(ctx);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  ctx.port = server.address().port;
  const call = (pathname, { method = "GET", headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: ctx.port, path: pathname, method, headers: { host: `127.0.0.1:${ctx.port}`, ...headers }, agent: false },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  const auth = { "x-observatory-token": ctx.token };
  try {
    const page = await call("/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-security-policy"], /script-src 'self'/);
    assert.match(page.body, /Fleet Observatory/);
    assert.equal((await call("/api/fleet")).status, 401);
    const fleet = await call("/api/fleet", { headers: auth });
    assert.equal(fleet.status, 200);
    const body = JSON.parse(fleet.body);
    assert.equal(body.bots[0].key, "house");
    assert.equal(body.bots[0].controlUi.openUrl, `http://127.0.0.1:18891/__claw-proxy/unlock#k=${"k".repeat(43)}`);
    assert.equal(body.swarm.running, false);
    assert.equal(body.bots[0].identity.family, "other", "no role known before the first read");
    assert.ok(body.families.some((f) => f.id === "markets"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = JSON.parse((await call("/api/fleet", { headers: auth })).body).bots[0].identity;
    assert.deepEqual(again, { name: "Mr. House", emoji: "🎰", role: "market-analysis-and-trading-infrastructure", family: "markets", avatar: null, reading: false });
    assert.equal((await call("/api/bots/house/avatar", { headers: auth })).status, 404);
    assert.equal((await call("/api/bots/house/avatar")).status, 401);
    const icon = await call("/icon.png");
    assert.equal(icon.headers["content-type"], "image/png");
    const manifest = await call("/manifest.webmanifest");
    assert.equal(JSON.parse(manifest.body).start_url, "/");
    assert.match(page.headers["content-security-policy"], /manifest-src 'self'/);
    assert.equal((await call("/api/fleet", { headers: { ...auth, host: "host.docker.internal:18780" } })).status, 421);
    assert.equal((await call("/api/fleet", { headers: { ...auth, origin: "https://evil.example" } })).status, 403);
    assert.equal((await call("/api/fleet", { method: "POST", headers: auth })).status, 405);
    assert.equal((await call("/api/bots/nobody/profile", { headers: auth })).status, 404);
    assert.equal((await call("/api/bots/house/diff?commit=zzz&file=MEMORY.md", { headers: auth })).status, 400);
    assert.equal((await call("/api/bots/house/diff?commit=abcdef1&file=../../x", { headers: auth })).status, 400);
    assert.equal((await call("/api/bots/house/transcript?session=../../x", { headers: auth })).status, 400);
    assert.deepEqual(JSON.parse((await call("/api/bots/house/history", { headers: auth })).body).commits, []);
  } finally {
    server.close();
  }
});

test("the script runs from a folder whose name has a space (the launchd copy)", () => {
  // Regression: the entry check compared import.meta.url (space → %20) with a
  // `file://` template (literal space), so the launchd copy under
  // "Application Support" exited 0 without running for seven nights.
  const dir = path.join(tmp("obs-space-"), "Application Support");
  fs.mkdirSync(dir);
  const copy = path.join(dir, "claw-observatory.mjs");
  fs.copyFileSync(new URL("../claw-observatory.mjs", import.meta.url), copy);
  const out = execFileSync(process.execPath, [copy, "help"], { encoding: "utf8" });
  assert.match(out, /^usage: claw-observatory\.mjs/);
});

test("roleFamily: each fleet role gets the intended family; the Creature line is the fallback", () => {
  const cases = {
    "security-research-and-systems": "security",
    "market-analysis-and-trading-infrastructure": "markets",
    "ai-and-alignment-research": "research",
    "hardware-sourcing-and-shop-ops": "hardware",
    "trusted-systems-and-operations": "systems",
    "operations-and-cloud-admin": "operations",
    "codebase-cartography-and-analysis": "research",
  };
  for (const [role, family] of Object.entries(cases)) assert.equal(roleFamily(role), family, role);
  // Nimbus has no role.yaml; its real Creature line also says "cloud".
  assert.equal(roleFamily(null, "Personal digital assistant — helpful, capable, a bit of a cloud-brain (hence the name)"), "assistant");
  assert.equal(roleFamily(null, null), "other");
  assert.equal(roleFamily("juggling"), "other");
  assert.equal(parseRoleYaml("# x\nrole: ai-and-alignment-research   # note\nphase: research\n"), "ai-and-alignment-research");
  assert.equal(parseRoleYaml("  role: indented-is-not-top-level\n"), null);
  assert.equal(parseRoleYaml("role: $(rm -rf)\n"), null);
});

test("declaredPort reads the compose binding even when Docker did not publish it", () => {
  const inspect = { HostConfig: { PortBindings: { "18789/tcp": [{ HostIp: "127.0.0.1", HostPort: "18791" }] } }, NetworkSettings: { Ports: {} } };
  assert.equal(declaredPort(inspect, 18789), 18791);
  assert.equal(declaredPort({}, 18789), null);
});

test("identity collector: fields, avatar inside avatars/ only, role line", () => {
  const home = makeHome();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
  writeAt(home, "workspace/avatars/face.png", png);
  writeAt(home, "workspace/IDENTITY.md", "- **Name:** Van Helsing\n- **Creature:** A learned hunter\n- **Emoji:** 🕯️\n- **Avatar:** avatars/face.png\n");
  const role = path.join(home, "role.yaml");
  fs.writeFileSync(role, "role: security-research-and-systems\n");
  const { value } = runCollector(collectIdentity, home, role);
  assert.equal(value.name, "Van Helsing");
  assert.equal(value.emoji, "🕯️");
  assert.equal(value.creature, "A learned hunter");
  assert.equal(value.role, "security-research-and-systems");
  assert.equal(value.avatar.mime, "image/png");
  assert.deepEqual(Buffer.from(value.avatar.b64, "base64"), png);

  for (const hostile of ["../identity/device.json", "avatars/../../identity/device.json", "/etc/hosts", "avatars/link.png"]) {
    writeAt(home, "workspace/IDENTITY.md", `- **Avatar:** ${hostile}\n`);
    fs.rmSync(path.join(home, "workspace/avatars/link.png"), { force: true });
    fs.symlinkSync(path.join(home, "identity/device.json"), path.join(home, "workspace/avatars/link.png"));
    const { raw, value: v } = runCollector(collectIdentity, home, role);
    assert.equal(v.avatar, null, hostile);
    assert.doesNotMatch(raw, /SECRETKEYMATERIAL/);
  }
  writeAt(home, "workspace/avatars/fake.png", "not an image at all");
  writeAt(home, "workspace/IDENTITY.md", "- **Avatar:** avatars/fake.png\n");
  assert.equal(runCollector(collectIdentity, home, role).value.avatar, null);
});

test("identityStore keeps entries on disk (mode 600) and skips persistence when asked", () => {
  const dir = tmp("obs-idstore-");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 2)]);
  const store = identityStore(dir);
  store.set("house", { name: "Mr. House", emoji: "🎰", role: "r", creature: "c" }, { bytes: png, mime: "image/png" });
  store.set("kaizen", { name: "Kaizen" }, null, { persist: false });
  assert.equal((fs.statSync(path.join(dir, "house.json")).mode & 0o777), 0o600);
  assert.equal((fs.statSync(path.join(dir, "house.png")).mode & 0o777), 0o600);
  assert.ok(!fs.existsSync(path.join(dir, "kaizen.json")), "an excluded bot never reaches disk");
  const reloaded = identityStore(dir).get("house");
  assert.equal(reloaded.name, "Mr. House");
  assert.deepEqual(reloaded.avatar.bytes, png);
  assert.equal(reloaded.avatar.version, store.get("house").avatar.version);
  assert.equal(identityStore(dir).get("kaizen"), null);
});

test("renderIcon draws a valid PNG; sniffImage knows the four types", () => {
  const icon = renderIcon(64);
  assert.equal(sniffImage(icon), "image/png");
  assert.equal(icon.readUInt32BE(16), 64);
  assert.equal(sniffImage(Buffer.from("GIF89a-and-more")), "image/gif");
  assert.equal(sniffImage(Buffer.from("<svg xmlns='x'>")), null);
});

test("ensureKey is stable; rotateKey replaces it", () => {
  const file = path.join(tmp("obs-key-"), "observatory-key");
  const first = ensureKey(file);
  assert.equal(ensureKey(file), first);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  const second = rotateKey(file);
  assert.notEqual(second, first);
  assert.equal(ensureKey(file), second);
});

test("planProxyRoutes: port + 100, sandboxed by name, published through the host, Nimbus direct", () => {
  const sandboxed = ["oasis-claw_oasis_sandboxed"];
  const bots = [
    { key: "house", container: "oasis-claw-house", declaredPort: 18791, hostPort: null, networks: sandboxed },
    { key: "helloworld", container: "oasis-claw-hello-world", declaredPort: 18796, hostPort: 18796, networks: ["oasis-claw_oasis_runtime"] },
    { key: "nimbus", container: "oasis-claw-runtime", declaredPort: 18789, hostPort: 18789, networks: ["oasis-claw_oasis_runtime"] },
    { key: "newbot", container: "oasis-claw-newbot", declaredPort: 18797, hostPort: null, networks: sandboxed },
    { key: "kaizen", container: "oasis-claw-pasa-kaizen", declaredPort: 18799, excluded: true, networks: sandboxed },
    { key: "island", container: "oasis-claw-island", declaredPort: 18798, hostPort: null, networks: ["other"] },
    { key: "clash", container: "oasis-claw-clash", declaredPort: 18680, hostPort: null, networks: sandboxed },
  ];
  const plan = planProxyRoutes(bots);
  assert.deepEqual(
    plan.routes.map((r) => `${r.listenPort}=${r.target}`),
    ["18891=oasis-claw-house:18789", "18896=host.docker.internal:18796", "18897=oasis-claw-newbot:18789"],
  );
  assert.deepEqual(plan.skipped.map((x) => x.key).sort(), ["clash", "island", "kaizen"], "18780 is the observatory's own port");
  const yaml = renderProxyRoutesOverride(plan);
  assert.match(yaml, /ROUTES: "18891=oasis-claw-house:18789, 18896=host\.docker\.internal:18796, 18897=oasis-claw-newbot:18789"/);
  assert.match(yaml, /- "127\.0\.0\.1:18897:18897"/);
  assert.match(yaml, /# no route for kaizen: excluded/);
  assert.doesNotMatch(yaml, /18789:18789|18889/);
});
