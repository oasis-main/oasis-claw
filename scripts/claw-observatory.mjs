#!/usr/bin/env node
// ── claw-observatory (CLAW-108) ──────────────────────────────────────────────
// One place to watch the fleet at three levels, without typing docker commands.
//
//   System 2  slow, high level   what work is on the .swarm boards
//   System 1  fast, low level    follow one agent or subagent session live:
//                                messages, thinking, tool calls, tool results
//   System 3  outer level        who each agent is: identity, soul, memory,
//                                dreams, age, reviewer record, mail contacts,
//                                and how those change night to night
//
// COMMANDS
//   list [--json]                      every bot: state, Control UI address, board
//   open <bot>|observatory|board       open an address in the default browser
//   serve [--port N] [--open] [--no-dashboard]
//                                      serve the observatory page on 127.0.0.1
//                                      (a stable address: bookmark it), and
//                                      start the dot_swarm dashboard beside it
//   snapshot [--dir PATH] [--no-commit]
//                                      copy each bot's self files into the
//                                      history repository and commit
//   pair <bot> [--approve REQUEST_ID]  list, or approve, a pending Control UI
//                                      device pairing
//   proxy-key                          create the port proxy access key if missing
//   feedback list|show|pull|set        the change requests written on the page
//                                      (see claw-observatory-feedback.mjs)
//
// TRUST MODEL — read before changing how data is read or served
//   1. Mike, 2026-08-10: agents must NOT be able to search other agents'
//      memories and transcripts. This tool reads all of them, so no bot may
//      reach it. It runs on the Mac, binds 127.0.0.1, and reads bot files with
//      `docker exec` over the Docker socket. It never runs as a container on a
//      bot network. The API also requires a per-run token and a loopback Host
//      header: Docker Desktop forwards host.docker.internal to the Mac's
//      loopback for any container that has a route out (Nimbus, Hello World).
//   2. Everything a bot wrote is untrusted text. The page renders it with
//      textContent only, under a CSP that allows no inline script.
//   3. The collectors only read. They lstat first and skip anything that is
//      not a regular file.
//   4. The snapshot never copies identity/device.json (the device private
//      key), openclaw.json, tokens, or transcripts.
//   5. The only writes the API takes are change requests (/api/feedback),
//      the Control UI open and approve (item 7), and the settings (item 8).
//      A write needs the token AND this page's Origin. The requests and their screenshots stay in the
//      state folder, which no bot mounts: a screenshot can show any agent's
//      memory.
//   7. Control UI (Mike, 2026-10-07, R2): on Mike's click, POST
//      /api/control-ui/<bot>/open reads that bot's gateway token and returns
//      it to this page in a URL fragment only, as `openclaw dashboard` does.
//      This server keeps no copy and never logs it. The approve route pairs
//      only a Control UI browser, never from the container's loopback, and
//      only for a few minutes after that open (judgeControlUiRequest).
//   8. Settings (Mike, 2026-10-08): PUT /api/user-md/<bot> replaces that
//      bot's workspace/USER.md, which openclaw puts in every prompt of that
//      bot. Only this page can send it (token + Origin, as item 5). The
//      container refuses the write when the file changed since the page read
//      it, never follows a symlink, and the server keeps the replaced text
//      in the state folder. PUT /api/settings keeps the user profile and the
//      swarm parameters there too. Nothing here reads or writes any other
//      bot file.
//   6. `serve` also starts the dot_swarm dashboard (`swarm gui`, 18781), where
//      the human claims, finishes, blocks and comments on items. A bot can
//      reach that port too, so the observatory starts it only after it proves
//      the fixed behavior (dot_swarm 2026-09-28): the page carries no token,
//      and a read without the token is refused. An older dot_swarm is not
//      started. The dashboard token is fresh for each run and reaches the
//      browser only in a URL fragment, from this token-gated API.
//
// DEPLOYMENT NOTE: `make observatory-snapshot-install` copies THIS FILE ALONE
// to ~/Library/Application Support/oasis-x/ for launchd (TCC blocks launchd
// from exec-ing anything inside ~/Documents). Keep the module free of static
// local imports. The page assets and claw-observatory-feedback.mjs are loaded
// only by `serve` and `feedback`, from the repo copy.

import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

export const BOT_HOME = "/home/node/.openclaw";
export const GATEWAY_PORT = 18789;
const CONTAINER_PREFIX = "oasis-claw-";
const PROXY_CONTAINER = "oasis-observatory-proxy";
const DEFAULT_PORT = 18780;
const SWARM_PORT = 18781;
const STATE_DIR =
  process.env.OASIS_OBSERVATORY_STATE_DIR ||
  path.join(HOME, "Library", "Application Support", "oasis-x", "observatory");
const SERVE_FILE = path.join(STATE_DIR, "serve.json");
export const PROXY_KEY_FILE = path.join(STATE_DIR, "proxy-key");
// The observatory's own access key. Stable across restarts, so a bookmark to
// http://127.0.0.1:18780/ keeps working (see createObservatoryServer).
export const OBSERVATORY_KEY_FILE = path.join(STATE_DIR, "observatory-key");
const IDENTITY_DIR = path.join(STATE_DIR, "identities");
export const DEFAULT_SNAPSHOT_DIR = path.join(STATE_DIR, "snapshots");
export const DEFAULT_FEEDBACK_DIR = path.join(STATE_DIR, "feedback");
const DEFAULT_PULL_DIR = path.join(SCRIPT_DIR, "..", ".swarm", "feedback");
// Loaded only when needed; see the DEPLOYMENT NOTE above.
const FEEDBACK_MODULE = new URL("./claw-observatory-feedback.mjs", import.meta.url);
const MAIL_ROOT = process.env.OASIS_CLAW_MAIL_ROOT || path.join(HOME, "Documents", "Runes", ".claw-mail");
// Containers the observatory never shows, reads, or stores. The pattern comes
// from OASIS_OBSERVATORY_EXCLUDE, else from the file `exclude` in the state
// folder (one pattern per line, `#` starts a comment), else nothing is
// excluded. Which deployments to hide is private to the host, so the public
// default names none.
export function excludePattern(env = process.env, stateDir = STATE_DIR) {
  let src = String(env.OASIS_OBSERVATORY_EXCLUDE || "").trim();
  if (!src) {
    try {
      src = fs
        .readFileSync(path.join(stateDir, "exclude"), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .join("|");
    } catch {
      src = "";
    }
  }
  return src ? new RegExp(src, "i") : null;
}
const EXCLUDE_RE = excludePattern();
const ASSET_DIR = path.join(SCRIPT_DIR, "observatory");
const ASSETS = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/swarm.js": ["swarm.js", "text/javascript; charset=utf-8"],
};

// ── process helpers ──────────────────────────────────────────────────────────

function run(cmd, args, { timeoutMs = 30_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          // err.message repeats the whole argv, which for `node -e` is the
          // collector source. Report stderr instead.
          const detail = String(stderr || "").trim().split("\n").slice(-3).join(" | ");
          const reason = detail || (err.killed ? "timed out" : `exit ${err.code ?? "?"}`);
          reject(new Error(`${cmd} ${args[0] ?? ""} failed: ${reason}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

const docker = (args, opts) => run("docker", args, opts);

function git(dir, args, opts) {
  return run(
    "git",
    ["-C", dir, "-c", "core.quotepath=off", "-c", "commit.gpgsign=false", ...args],
    opts,
  );
}

/** Source for `node -e` inside a bot container. The collector must be
 *  self-contained: it is stringified, so it can use only its parameters and
 *  language built-ins. */
export function collectorScript(fn, home = BOT_HOME) {
  return (
    `"use strict";` +
    `const __r=(${fn.toString()})(require("fs"),require("path"),${JSON.stringify(home)},...process.argv.slice(1));` +
    `process.stdout.write(JSON.stringify(__r));`
  );
}

async function collect(container, fn, args = [], opts = {}) {
  const out = await docker(["exec", container, "node", "-e", collectorScript(fn), ...args.map(String)], {
    timeoutMs: 60_000,
    ...opts,
  });
  return JSON.parse(out);
}

// ── fleet discovery ──────────────────────────────────────────────────────────

export function sanitizeKey(raw) {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40);
}

export function envMap(inspect) {
  const env = new Map();
  for (const entry of inspect?.Config?.Env ?? []) {
    const i = entry.indexOf("=");
    if (i > 0) {
      env.set(entry.slice(0, i), entry.slice(i + 1));
    }
  }
  return env;
}

/** Map a path inside a container to the host path of the bind mount that
 *  serves it (longest matching destination wins, so a nested shield mount
 *  shadows its parent the same way it does inside the container). */
export function hostPathFor(mounts, containerPath) {
  let best = null;
  for (const mount of mounts ?? []) {
    if (mount.Type !== "bind") {
      continue;
    }
    const dest = String(mount.Destination).replace(/\/+$/, "");
    if (containerPath === dest || containerPath.startsWith(`${dest}/`)) {
      if (!best || dest.length > best.dest.length) {
        best = { dest, source: String(mount.Source) };
      }
    }
  }
  if (!best) {
    return null;
  }
  return best.source.replace(/^\/host_mnt(?=\/)/, "") + containerPath.slice(best.dest.length);
}

export function publishedPort(inspect, containerPort) {
  const bindings = inspect?.NetworkSettings?.Ports?.[`${containerPort}/tcp`] ?? [];
  const hit = bindings.find((b) => b && /^(127\.0\.0\.1|0\.0\.0\.0|::|)$/.test(b.HostIp ?? ""));
  return hit ? Number(hit.HostPort) : null;
}

/** The host port that compose declared for a container port, whether or not
 *  Docker published it (it does not publish for an internal-only network). */
export function declaredPort(inspect, containerPort) {
  const bindings = inspect?.HostConfig?.PortBindings?.[`${containerPort}/tcp`] ?? [];
  const hit = bindings.find((b) => b && /^(127\.0\.0\.1|0\.0\.0\.0|::|)$/.test(b.HostIp ?? "") && b.HostPort);
  return hit ? Number(hit.HostPort) : null;
}

// ── roles: the color of each bot on the page ────────────────────────────────
// A bot's color shows the job it was deployed for: the `role:` line of
// bots/<name>/role.yaml (mounted at /app/role.yaml). Families, not bots, get
// colors, so two bots with the same kind of job share one; the avatar tells
// them apart. The first family whose pattern matches wins. A bot without a
// role.yaml (Nimbus) is matched on the Creature line of its IDENTITY.md.
// The colors themselves are in scripts/observatory/app.css (.fam-<id>).
export const ROLE_FAMILIES = [
  { id: "security", label: "Security", re: /secur|defen[cs]e|threat|vuln|red-?team/ },
  { id: "markets", label: "Markets and trading", re: /market|trading|financ|invest|pricing/ },
  { id: "research", label: "Research", re: /research|alignment|science|model|analysis|cartograph/ },
  { id: "hardware", label: "Hardware and shop", re: /hardware|firmware|sourcing|shop|fabricat|manufactur/ },
  // Before systems and operations: Nimbus's Creature line ("Personal digital
  // assistant … a bit of a cloud-brain") would otherwise match "cloud".
  { id: "assistant", label: "Personal assistant", re: /assistant|personal|concierge|secretary/ },
  { id: "systems", label: "Systems and governance", re: /systems|governance|fleet/ },
  { id: "operations", label: "Operations and admin", re: /operations|\bops\b|admin|cloud|infra/ },
];
export const OTHER_FAMILY = { id: "other", label: "Other" };

export function roleFamily(...texts) {
  for (const text of texts) {
    const t = String(text ?? "").toLowerCase();
    if (!t) continue;
    const family = ROLE_FAMILIES.find((f) => f.re.test(t));
    if (family) return family.id;
  }
  return OTHER_FAMILY.id;
}

export function parseRoleYaml(text) {
  const m = String(text ?? "").match(/^role:\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,79})\s*(?:#.*)?$/m);
  return m ? m[1] : null;
}

function readRoleFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 512 * 1024) return null;
    return parseRoleYaml(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function parseProxyRoutes(spec) {
  const routes = [];
  for (const part of String(spec ?? "").split(",")) {
    const m = part.trim().match(/^(\d+)=([^:=\s]+):(\d+)$/);
    if (m) {
      routes.push({ listenPort: Number(m[1]), targetHost: m[2], targetPort: Number(m[3]) });
    }
  }
  return routes;
}

// ── port proxy routes, generated from the fleet ──────────────────────────────
// `make observatory-proxy-up` (bots/Makefile) writes these into a compose
// override, so a new bot gets a Control UI address without a hand edit.
// One route per bot: listen port = the bot's declared gateway port + 100.
//   - on the sandboxed network: the proxy (also on it) reaches the container;
//   - published on the Mac (Hello World): through host.docker.internal;
//   - host port 18789 (Nimbus): no route, the browser opens it directly.
export const SANDBOXED_NETWORK = "oasis-claw_oasis_sandboxed";
const RESERVED_PORTS = new Set([DEFAULT_PORT, SWARM_PORT, GATEWAY_PORT]);

export function planProxyRoutes(bots) {
  const routes = [];
  const skipped = [];
  const taken = new Set([...RESERVED_PORTS, ...bots.map((b) => b.declaredPort).filter(Boolean)]);
  for (const b of bots) {
    if (b.excluded) {
      skipped.push({ key: b.key, reason: "excluded (OASIS_OBSERVATORY_EXCLUDE)" });
      continue;
    }
    if (!b.declaredPort) {
      skipped.push({ key: b.key, reason: "no host port declared for 18789" });
      continue;
    }
    if (b.declaredPort === GATEWAY_PORT) continue;
    const listenPort = b.declaredPort + 100;
    let target = null;
    if ((b.networks ?? []).includes(SANDBOXED_NETWORK)) target = `${b.container}:${GATEWAY_PORT}`;
    else if (b.hostPort) target = `host.docker.internal:${b.hostPort}`;
    if (!target) {
      skipped.push({ key: b.key, reason: "neither on the sandboxed network nor published" });
      continue;
    }
    if (taken.has(listenPort) || routes.some((r) => r.listenPort === listenPort)) {
      skipped.push({ key: b.key, reason: `port ${listenPort} is already in use` });
      continue;
    }
    routes.push({ key: b.key, listenPort, target });
  }
  routes.sort((a, b) => a.listenPort - b.listenPort);
  return { routes, skipped };
}

export function renderProxyRoutesOverride({ routes, skipped }) {
  const lines = [
    "# GENERATED by `claw-observatory.mjs proxy-routes` (bots/Makefile: observatory-proxy-up).",
    "# Do not edit: the next `make observatory-proxy-up` rewrites it from the fleet.",
    ...skipped.map((s) => `# no route for ${s.key}: ${s.reason}`),
    "services:",
    "  port-proxy:",
    "    environment:",
    // ", " keeps the value identical to the hand-written list it replaced,
    // so the first generated run does not recreate the proxy.
    `      ROUTES: ${JSON.stringify(routes.map((r) => `${r.listenPort}=${r.target}`).join(", "))}`,
    "    ports:",
    ...routes.map((r) => `      - "127.0.0.1:${r.listenPort}:${r.listenPort}"`),
    "",
  ];
  return lines.join("\n");
}

/** Where a browser can open this bot's Control UI. The gateway allows only the
 *  container-port origin, so a direct publish works only on host port 18789;
 *  any other bot needs the observatory port proxy (scripts/claw-port-proxy.mjs). */
export function controlUiFor({ container, hostPort }, routes) {
  if (hostPort === GATEWAY_PORT) {
    return { url: `http://127.0.0.1:${GATEWAY_PORT}/`, via: "direct" };
  }
  const route = routes.find(
    (r) =>
      r.targetHost === container ||
      (hostPort != null && r.targetHost === "host.docker.internal" && r.targetPort === hostPort),
  );
  if (route) {
    return { url: `http://127.0.0.1:${route.hostPort}/`, via: "proxy" };
  }
  return { url: null, via: hostPort != null ? "origin-mismatch" : "unpublished" };
}

/** A random access key kept in `file`. Created on first use with mode 600 in
 *  the observatory state directory, which no bot mounts. Used for the port
 *  proxy (scripts/claw-port-proxy.mjs explains why it is locked) and for the
 *  observatory itself. */
export function ensureProxyKey(file = PROXY_KEY_FILE) {
  return ensureKey(file);
}

/** Replace the key in `file`. Every browser must unlock again. */
export function rotateKey(file) {
  fs.rmSync(file, { force: true });
  return ensureKey(file);
}

export function ensureKey(file) {
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[A-Za-z0-9_-]{32,256}$/.test(existing)) {
      return existing;
    }
  } catch {
    // no key yet
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(file, `${key}\n`, { mode: 0o600 });
  return key;
}

/** Add `controlUi.openUrl`: the address a browser should open. A proxied UI
 *  goes through the proxy's unlock page first, which reads the key from the
 *  URL fragment (never sent to a server) and sets the access cookie. */
export function withOpenUrls(fleet, key) {
  return {
    ...fleet,
    bots: fleet.bots.map((b) => ({
      ...b,
      controlUi: {
        ...b.controlUi,
        openUrl: b.controlUi.via === "proxy" && key ? `${b.controlUi.url}__claw-proxy/unlock#k=${key}` : b.controlUi.url,
      },
    })),
  };
}

// ── one-click Control UI (Mike, 2026-10-07, R2) ──────────────────────────────
// A Control UI shows the chat only after three steps: the port proxy cookie
// (sandboxed bots), the bot's gateway token, and a paired browser device.
// Without the token the gateway closes the socket as unauthorized, and the UI
// reports only "Could not connect". So the page asks this server for a
// signed-in address (POST .../open), and then pairs the browser it opened
// (POST .../approve).

export const CONTROL_UI_CLIENT = "openclaw-control-ui";
const GATEWAY_TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;
/** How long after an open the observatory accepts a pairing for that bot. */
export const PAIRING_WINDOW_MS = 3 * 60 * 1000;

/** Collector: the gateway token the gateway checks. openclaw.json holds a file
 *  SecretRef to `.gateway-token` (VH-002), so the token is read from that file;
 *  a literal string in openclaw.json is still honoured for a bot on an older
 *  image. Only the open route calls this collector; the snapshot and every
 *  other route never do. */
export function collectGatewayToken(fs, path, home) {
  let auth;
  try {
    auth = (JSON.parse(fs.readFileSync(path.join(home, "openclaw.json"), "utf8")).gateway || {}).auth || {};
  } catch {
    return { mode: null, token: null };
  }
  if (typeof auth.token === "string") return { mode: auth.mode || null, token: auth.token };
  try {
    const token = fs.readFileSync(path.join(home, ".gateway-token"), "utf8").trim();
    return { mode: auth.mode || null, token: token || null };
  } catch {
    return { mode: auth.mode || null, token: null };
  }
}

/** The address that opens `bot`'s Control UI signed in. The key and the token
 *  are in the fragment, which a browser never sends to a server. */
export function controlUiSignedInUrl(bot, { proxyKey, gatewayToken }) {
  const base = bot?.controlUi?.url;
  if (!base) return null;
  if (!GATEWAY_TOKEN_RE.test(String(gatewayToken ?? ""))) throw new Error(`${bot.key}: no usable gateway token`);
  if (bot.controlUi.via === "proxy") {
    return proxyKey ? `${base}__claw-proxy/unlock#k=${proxyKey}&token=${gatewayToken}` : null;
  }
  return `${base}chat?session=main#token=${gatewayToken}`;
}

/** May the observatory approve this pending pairing request? Only a Control UI
 *  browser: a bot's own CLI or gateway client asking for more scopes is a
 *  privilege grant that Mike makes by hand (`make pair`). Never a client on the
 *  container's loopback, because the bot itself holds its own token. Only
 *  within PAIRING_WINDOW_MS after Mike opened the UI from this page (`armedAt`).
 *  `viaProxy` marks a request that came through the port proxy, which a
 *  browser reaches only with the access key; the page approves those without
 *  a second click. */
export function judgeControlUiRequest(request, { proxyAddresses = [], armedAt = null, now = Date.now() } = {}) {
  if (request?.clientId !== CONTROL_UI_CLIENT) return { ok: false, reason: "not a Control UI browser" };
  const ip = String(request.remoteIp ?? "").replace(/^::ffff:/, "");
  if (!ip || ip === "::1" || ip.startsWith("127.")) return { ok: false, reason: "made inside the bot's container" };
  if (armedAt == null || now - armedAt > PAIRING_WINDOW_MS) {
    return { ok: false, reason: "open the Control UI from the observatory first" };
  }
  return { ok: true, viaProxy: proxyAddresses.includes(ip) };
}

async function listDevices(container) {
  const raw = await docker(["exec", container, "openclaw", "devices", "list", "--json"], { timeoutMs: 30_000 });
  const data = JSON.parse(raw.slice(raw.indexOf("{")));
  return { pending: data.pending ?? [], paired: data.paired ?? [] };
}

/** Collector: the pending device pairing requests, read from the gateway's
 *  own file (devices/pending.json). Starting `openclaw devices list` takes
 *  about 5 s; this read takes well under 1 s, so the page can poll it.
 *  Expiry follows openclaw (pairing-files.ts pruneExpiredPending, 5 min TTL).
 *  The public key and any other field stay inside the container. */
export function collectPendingPairing(fs, path, home, nowArg) {
  const TTL_MS = 5 * 60 * 1000;
  const now = Number(nowArg) || Date.now();
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(home, "devices", "pending.json"), "utf8")) || {};
  } catch {
    return [];
  }
  const out = [];
  for (const r of Object.values(raw)) {
    if (!r || typeof r !== "object" || typeof r.requestId !== "string") continue;
    const seen = Number(r.refreshedAtMs || r.ts);
    if (!(now - seen <= TTL_MS)) continue;
    out.push({
      requestId: r.requestId,
      clientId: typeof r.clientId === "string" ? r.clientId : null,
      platform: typeof r.platform === "string" ? r.platform : null,
      remoteIp: typeof r.remoteIp === "string" ? r.remoteIp : null,
      scopes: Array.isArray(r.scopes) ? r.scopes.filter((x) => typeof x === "string") : [],
      ts: Number(r.ts) || null,
    });
  }
  return out;
}

export function describeBot(inspect, routes, exclude = EXCLUDE_RE) {
  const container = String(inspect?.Name ?? "").replace(/^\//, "");
  const mounts = inspect?.Mounts ?? [];
  if (!container.startsWith(CONTAINER_PREFIX) || !mounts.some((m) => m.Destination === BOT_HOME)) {
    return null;
  }
  const env = envMap(inspect);
  const agentName = env.get("OASIS_AGENT_NAME") || null;
  // The key is the bot's .claw-mail mailbox name (nimbus, house, helloworld):
  // short, stable, and what the other fleet tools call the bot. The container
  // suffix is only the fallback, because Nimbus's container is "-runtime" and
  // OASIS_AGENT_NAME is a display name ("Mr. House").
  const inbox = hostPathFor(mounts, "/reach/mail/inbox");
  const mailbox = inbox ? sanitizeKey(path.basename(path.dirname(inbox))) : null;
  const key = mailbox || sanitizeKey(container.slice(CONTAINER_PREFIX.length));
  const hostPort = publishedPort(inspect, GATEWAY_PORT);
  const swarmDir = env.get("OASIS_SWARM_DIR") || null;
  const roleFile = hostPathFor(mounts, "/app/role.yaml");
  return {
    key,
    container,
    agentName,
    mailbox,
    state: inspect?.State?.Status ?? "unknown",
    health: inspect?.State?.Health?.Status ?? null,
    running: inspect?.State?.Status === "running",
    excluded: !!exclude && (exclude.test(container) || exclude.test(key)),
    networks: Object.keys(inspect?.NetworkSettings?.Networks ?? {}),
    hostPort,
    declaredPort: declaredPort(inspect, GATEWAY_PORT),
    role: roleFile ? readRoleFile(roleFile) : null,
    controlUi: controlUiFor({ container, hostPort }, routes),
    board: swarmDir ? { containerPath: swarmDir, hostPath: hostPathFor(mounts, swarmDir) } : null,
  };
}

// `docker inspect` costs about 3.1 s for EACH container that is only on an
// internal:true network on this Docker Desktop, and about 60 ms for the others
// (measured 2026-09-15: 15 s for the whole fleet in one call, 3.1 s in
// parallel). Everything used from it (name, mounts, env, port bindings,
// networks) is fixed while a container keeps its ID and state, so it is read
// once per (ID, state), in parallel. Live state and health come from
// `docker ps`, which takes about 65 ms for the whole fleet.
const inspectCache = new Map();

export function parseHealth(status) {
  const m = String(status ?? "").match(/\((healthy|unhealthy|health: starting)\)/);
  if (!m) {
    return null;
  }
  return m[1] === "health: starting" ? "starting" : m[1];
}

export async function discoverFleet() {
  const rows = (await docker(["ps", "-a", "--no-trunc", "--format", "{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Status}}"]))
    .split("\n")
    .map((line) => {
      const [id, name, state, status] = line.split("\t");
      return { id, name, state, status };
    })
    .filter((r) => r.id && (r.name?.startsWith(CONTAINER_PREFIX) || r.name === PROXY_CONTAINER));
  if (rows.length === 0) {
    return { bots: [], proxy: null };
  }
  const cacheKey = (r) => `${r.id}:${r.state}`;
  const wanted = new Set(rows.map(cacheKey));
  for (const key of inspectCache.keys()) {
    if (!wanted.has(key)) {
      inspectCache.delete(key);
    }
  }
  await Promise.all(
    rows
      .filter((r) => !inspectCache.has(cacheKey(r)))
      .map(async (r) => {
        try {
          const [inspect] = JSON.parse(await docker(["inspect", r.id]));
          inspectCache.set(cacheKey(r), inspect);
        } catch {
          // removed between `docker ps` and `docker inspect`
        }
      }),
  );
  const inspects = rows
    .filter((r) => inspectCache.has(cacheKey(r)))
    .map((r) => {
      const inspect = inspectCache.get(cacheKey(r));
      const health = parseHealth(r.status);
      return { ...inspect, State: { ...inspect.State, Status: r.state, Health: health ? { Status: health } : undefined } };
    });
  const proxyInspect = inspects.find((i) => i.Name === `/${PROXY_CONTAINER}`) ?? null;
  const proxyRunning = proxyInspect?.State?.Status === "running";
  const routes = proxyRunning
    ? parseProxyRoutes(envMap(proxyInspect).get("ROUTES"))
        .map((r) => ({ ...r, hostPort: publishedPort(proxyInspect, r.listenPort) }))
        .filter((r) => r.hostPort)
    : [];
  const bots = [];
  const seen = new Set();
  for (const inspect of inspects) {
    const bot = describeBot(inspect, routes);
    if (!bot) {
      continue;
    }
    let key = bot.key;
    for (let n = 2; seen.has(key); n++) {
      key = `${bot.key}-${n}`;
    }
    seen.add(key);
    bots.push({ ...bot, key });
  }
  bots.sort((a, b) => a.key.localeCompare(b.key));
  return {
    bots,
    proxy: proxyInspect
      ? {
          state: proxyInspect.State?.Status ?? "unknown",
          health: proxyInspect.State?.Health?.Status ?? null,
          routes,
          // A gateway sees a proxied browser at one of these addresses
          // (approveControlUiRequest uses them).
          addresses: Object.values(proxyInspect.NetworkSettings?.Networks ?? {})
            .map((n) => n?.IPAddress)
            .filter(Boolean),
        }
      : null,
  };
}

// ── collectors (run INSIDE a bot container; self-contained by design) ────────

export function collectProfile(fs, path, home) {
  const W = path.join(home, "workspace");
  const MAX_FILE = 2 * 1024 * 1024;
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const regular = (p) => {
    try {
      const st = fs.lstatSync(p);
      return st.isFile() ? st : null;
    } catch {
      return null;
    }
  };
  const readText = (p) => {
    const st = regular(p);
    if (!st || st.size > MAX_FILE) {
      return null;
    }
    return { text: fs.readFileSync(p, "utf8"), size: st.size, mtimeMs: st.mtimeMs };
  };
  const cut = (text, n, mode) => {
    if (text.length <= n) {
      return { text, truncated: 0, mode };
    }
    return { text: mode === "tail" ? text.slice(-n) : text.slice(0, n), truncated: text.length - n, mode };
  };
  const doc = (rel, n, mode = "head") => {
    const r = readText(path.join(W, rel));
    return r ? { name: rel, size: r.size, mtimeMs: r.mtimeMs, ...cut(r.text, n, mode) } : null;
  };
  const tailLines = (p, maxBytes) => {
    const st = regular(p);
    if (!st) {
      return [];
    }
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n");
      if (start > 0) {
        lines.shift();
      }
      return lines.filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }
  };
  const listMd = (dir) => {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".md"))
      .map((n) => ({ name: n, st: regular(path.join(dir, n)) }))
      .filter((x) => x.st)
      .map((x) => ({ name: x.name, size: x.st.size, mtimeMs: x.st.mtimeMs }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };
  const parseJson = (p) => {
    const r = readText(p);
    if (!r) {
      return null;
    }
    try {
      return JSON.parse(r.text);
    } catch {
      return null;
    }
  };

  const config = parseJson(path.join(home, "openclaw.json")) ?? {};
  // device.json also holds the private key; take the birth time and nothing else.
  const device = parseJson(path.join(home, "identity", "device.json"));
  const createdAtMs = typeof device?.createdAtMs === "number" ? device.createdAtMs : null;

  const identity = doc("IDENTITY.md", 8000);
  const nameMatch = identity ? identity.text.match(/\*\*Name:?\*\*:?\s*(.+)/i) : null;

  const phases = {};
  for (const phase of ["light", "rem", "deep"]) {
    const dir = path.join(W, "memory", "dreaming", phase);
    const files = listMd(dir);
    const last = files[files.length - 1];
    const lastText = last ? readText(path.join(dir, last.name)) : null;
    phases[phase] = {
      count: files.length,
      latest: last && lastText ? { ...last, ...cut(lastText.text, 10000, "head") } : null,
    };
  }

  const notes = listMd(path.join(W, "memory"));
  const isDaily = (n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n.name);
  const daily = notes.filter(isDaily);
  const topics = notes.filter((n) => !isDaily(n));
  const lastDaily = daily[daily.length - 1];
  const lastDailyText = lastDaily ? readText(path.join(W, "memory", lastDaily.name)) : null;

  const reviewer = { rows: 0, window24h: {}, window7d: {}, recent: [] };
  for (const line of tailLines(path.join(home, "logs", "reviewer", "reviewer-audit.jsonl"), 8 * 1024 * 1024)) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const t = Date.parse(row.ts);
    if (!Number.isFinite(t)) {
      continue;
    }
    reviewer.rows++;
    const verdict = String(row.verdict ?? "unknown");
    if (now - t <= DAY) {
      reviewer.window24h[verdict] = (reviewer.window24h[verdict] ?? 0) + 1;
    }
    if (now - t <= 7 * DAY) {
      reviewer.window7d[verdict] = (reviewer.window7d[verdict] ?? 0) + 1;
    }
    if (verdict !== "allow") {
      reviewer.recent.push({
        ts: row.ts,
        verdict,
        toolName: row.toolName ?? null,
        principle: row.principle ?? null,
        unattended: Boolean(row.unattended),
        reason: String(row.reason ?? "").slice(0, 500),
      });
    }
  }
  reviewer.recent = reviewer.recent.slice(-20).reverse();

  const dreamEvents = { promotions: 0, lastPromotion: null, lastDream: {} };
  for (const line of tailLines(path.join(W, "memory", ".dreams", "events.jsonl"), 2 * 1024 * 1024)) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "memory.promotion.applied") {
      dreamEvents.promotions++;
      dreamEvents.lastPromotion = { ts: e.timestamp ?? null, applied: e.applied ?? null, candidates: e.candidates ?? null };
    } else if (e.type === "memory.dream.completed" && typeof e.phase === "string") {
      dreamEvents.lastDream[e.phase] = { ts: e.timestamp ?? null, lineCount: e.lineCount ?? null, outcome: e.outcome ?? null };
    }
  }

  return {
    name: nameMatch ? nameMatch[1].trim() : null,
    createdAtMs,
    model: config?.agents?.defaults?.model?.primary ?? null,
    dreaming: config?.plugins?.entries?.["memory-core"]?.config?.dreaming ?? null,
    docs: {
      identity,
      soul: doc("SOUL.md", 24000),
      user: doc("USER.md", 12000),
      memory: doc("MEMORY.md", 60000),
      dreams: doc("DREAMS.md", 40000, "tail"),
      agents: doc("AGENTS.md", 24000),
      tools: doc("TOOLS.md", 12000),
      heartbeat: doc("HEARTBEAT.md", 4000),
    },
    phases,
    notes: {
      daily: daily.slice(-60),
      topics,
      latestDaily: lastDaily && lastDailyText ? { ...lastDaily, ...cut(lastDailyText.text, 16000, "head") } : null,
    },
    reviewer,
    dreamEvents,
  };
}

export function collectSessions(fs, path, home) {
  const agentsDir = path.join(home, "agents");
  const toMs = (v) => (typeof v === "number" ? v : Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
  const kindOf = (key) => {
    if (/:subagent:/.test(key)) return "subagent";
    if (/:cron:/.test(key)) return "cron";
    if (/:hook:/.test(key)) return "hook";
    if (/:heartbeat$/.test(key)) return "heartbeat";
    // memory-core runs each dream phase as its own session
    if (/:dreaming-/.test(key)) return "dream";
    if (/:(telegram|discord|slack|whatsapp|signal|webchat):/.test(key)) return "chat";
    if (/:main$/.test(key)) return "main";
    return "other";
  };
  let agents = [];
  try {
    agents = fs.readdirSync(agentsDir).filter((a) => /^[A-Za-z0-9_-]{1,64}$/.test(a));
  } catch {
    return { sessions: [] };
  }
  const sessions = [];
  for (const agent of agents) {
    const dir = path.join(agentsDir, agent, "sessions");
    const storePath = path.join(dir, "sessions.json");
    let store;
    try {
      const st = fs.lstatSync(storePath);
      if (!st.isFile() || st.size > 64 * 1024 * 1024) {
        continue;
      }
      store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    } catch {
      continue;
    }
    for (const [key, s] of Object.entries(store ?? {})) {
      if (!s || typeof s !== "object") {
        continue;
      }
      const sessionId = typeof s.sessionId === "string" && /^[0-9a-f-]{8,64}$/i.test(s.sessionId) ? s.sessionId : null;
      let transcript = null;
      if (sessionId) {
        try {
          const st = fs.lstatSync(path.join(dir, `${sessionId}.jsonl`));
          if (st.isFile()) {
            transcript = { size: st.size, mtimeMs: st.mtimeMs };
          }
        } catch {
          // no transcript on disk (reset or never written)
        }
      }
      sessions.push({
        agent,
        key,
        kind: kindOf(key),
        sessionId,
        status: s.status ?? null,
        updatedAt: toMs(s.updatedAt),
        startedAt: toMs(s.startedAt ?? s.sessionStartedAt),
        endedAt: toMs(s.endedAt),
        model: s.model ?? null,
        totalTokens: typeof s.totalTokens === "number" ? s.totalTokens : null,
        contextTokens: typeof s.contextTokens === "number" ? s.contextTokens : null,
        compactionCount: typeof s.compactionCount === "number" ? s.compactionCount : 0,
        lastChannel: s.lastChannel ?? null,
        transcript,
      });
    }
  }
  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { sessions: sessions.slice(0, 300) };
}

export function collectTranscript(fs, path, home, agent, sessionId, limitRaw) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(agent)) || !/^[0-9a-f-]{8,64}$/i.test(String(sessionId))) {
    return { error: "invalid session id" };
  }
  const limit = Math.min(1000, Math.max(1, Number.parseInt(limitRaw, 10) || 120));
  const file = path.join(home, "agents", agent, "sessions", `${sessionId}.jsonl`);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { error: "transcript not found" };
  }
  if (!st.isFile()) {
    return { error: "transcript not found" };
  }
  const MAX = 6 * 1024 * 1024;
  const start = Math.max(0, st.size - MAX);
  const fd = fs.openSync(file, "r");
  let lines;
  try {
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    lines = buf.toString("utf8").split("\n");
    if (start > 0) {
      lines.shift();
    }
  } finally {
    fs.closeSync(fd);
  }
  const cap = (value, n) => {
    const s = typeof value === "string" ? value : String(value ?? "");
    return s.length > n ? `${s.slice(0, n)}\n…[${s.length - n} more characters]` : s;
  };
  const entries = [];
  for (const line of lines) {
    if (!line) {
      continue;
    }
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "message" || !o.message || typeof o.message !== "object") {
      if (typeof o.type === "string" && o.type !== "session") {
        entries.push({ event: o.type, ts: o.timestamp ?? null });
      }
      continue;
    }
    const m = o.message;
    const parts = [];
    const limitFor = m.role === "toolResult" ? 4000 : 16000;
    if (typeof m.content === "string") {
      parts.push({ t: "text", text: cap(m.content, limitFor) });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (!p || typeof p !== "object") continue;
        if (p.type === "text") parts.push({ t: "text", text: cap(p.text, limitFor) });
        else if (p.type === "thinking") parts.push({ t: "thinking", text: cap(p.thinking, 16000) });
        else if (p.type === "toolCall") {
          let args;
          try {
            args = JSON.stringify(p.arguments ?? {}, null, 2);
          } catch {
            args = "[unserializable arguments]";
          }
          parts.push({ t: "call", name: String(p.name ?? ""), args: cap(args, 6000), id: typeof p.id === "string" ? p.id.slice(0, 128) : null });
        } else parts.push({ t: String(p.type ?? "unknown") });
      }
    }
    // Token counts only (the session view shows them per turn).
    const u = m.usage && typeof m.usage === "object" ? m.usage : null;
    const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    entries.push({
      ts: o.timestamp ?? m.timestamp ?? null,
      role: String(m.role ?? "unknown"),
      model: m.model ?? null,
      stopReason: m.stopReason ?? null,
      toolName: m.toolName ?? null,
      toolCallId: typeof m.toolCallId === "string" ? m.toolCallId.slice(0, 128) : null,
      isError: m.isError ?? null,
      usage: u ? { input: n(u.input), output: n(u.output), cacheRead: n(u.cacheRead), cacheWrite: n(u.cacheWrite), total: n(u.totalTokens) } : null,
      parts,
    });
  }
  return { size: st.size, mtimeMs: st.mtimeMs, truncatedHead: start > 0, entries: entries.slice(-limit) };
}

/** Who the bot presents as: IDENTITY.md Name / Emoji / Creature / Avatar,
 *  the avatar image itself (workspace/avatars/ only, a regular file, 4 MB at
 *  most, a real PNG, JPEG, GIF or WebP), and the role.yaml `role:` line. */
export function collectIdentity(fs, path, home, rolePath = "/app/role.yaml") {
  const W = path.join(home, "workspace");
  const readFile = (file, max) => {
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > max) return null;
      return fs.readFileSync(file);
    } catch {
      return null;
    }
  };
  const text = (readFile(path.join(W, "IDENTITY.md"), 256 * 1024) || Buffer.alloc(0)).toString("utf8");
  const field = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  const clip = (s, n) => (s == null ? null : Array.from(s).slice(0, n).join(""));
  const avatarRel = field(/^\s*[-*]\s*\*\*Avatar:\*\*\s*(.+)$/im);
  let avatar = null;
  if (avatarRel && /^avatars\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(avatarRel)) {
    const b = readFile(path.join(W, avatarRel), 4 * 1024 * 1024);
    if (b) {
      const mime =
        b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG"
          ? "image/png"
          : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
            ? "image/jpeg"
            : b.toString("latin1", 0, 4) === "GIF8"
              ? "image/gif"
              : b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP"
                ? "image/webp"
                : null;
      if (mime) avatar = { mime, size: b.length, b64: b.toString("base64") };
    }
  }
  const roleText = (readFile(rolePath, 512 * 1024) || Buffer.alloc(0)).toString("utf8");
  const role = roleText.match(/^role:\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,79})\s*(?:#.*)?$/m);
  return {
    name: clip(field(/^\s*[-*]\s*\*\*Name:\*\*\s*(.+)$/im), 80),
    emoji: clip(field(/^\s*[-*]\s*\*\*Emoji:\*\*\s*(.+)$/im), 4),
    creature: clip(field(/^\s*[-*]\s*\*\*Creature:\*\*\s*(.+)$/im), 300),
    role: role ? role[1] : null,
    avatar,
  };
}

export function collectSnapshot(fs, path, home) {
  const W = path.join(home, "workspace");
  const ROOT = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md", "BOOTSTRAP.md", "MEMORY.md", "DREAMS.md"];
  const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
  const MAX_FILE = 2 * 1024 * 1024;
  const MAX_TOTAL = 48 * 1024 * 1024;
  const files = {};
  const skipped = [];
  let total = 0;
  const take = (rel) => {
    let st;
    try {
      st = fs.lstatSync(path.join(W, rel));
    } catch {
      return;
    }
    if (!st.isFile()) {
      skipped.push({ file: rel, why: "not a regular file" });
    } else if (st.size > MAX_FILE) {
      skipped.push({ file: rel, why: "larger than 2 MB", size: st.size });
    } else if (total + st.size > MAX_TOTAL) {
      skipped.push({ file: rel, why: "snapshot total cap reached" });
    } else {
      files[rel] = fs.readFileSync(path.join(W, rel), "utf8");
      total += st.size;
    }
  };
  const mdIn = (rel) => {
    try {
      return fs.readdirSync(path.join(W, rel)).filter((n) => NAME.test(n)).sort();
    } catch {
      return [];
    }
  };
  ROOT.forEach(take);
  for (const n of mdIn("memory")) take(`memory/${n}`);
  for (const phase of ["light", "rem", "deep"]) {
    for (const n of mdIn(`memory/dreaming/${phase}`)) take(`memory/dreaming/${phase}/${n}`);
  }
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(home, "openclaw.json"), "utf8"));
  } catch {
    config = {};
  }
  let createdAtMs = null;
  try {
    const device = JSON.parse(fs.readFileSync(path.join(home, "identity", "device.json"), "utf8"));
    createdAtMs = typeof device.createdAtMs === "number" ? device.createdAtMs : null;
  } catch {
    createdAtMs = null;
  }
  const nameMatch = String(files["IDENTITY.md"] ?? "").match(/\*\*Name:?\*\*:?\s*(.+)/i);
  return {
    files,
    skipped,
    meta: {
      name: nameMatch ? nameMatch[1].trim() : null,
      createdAtMs,
      model: config?.agents?.defaults?.model?.primary ?? null,
      dreaming: config?.plugins?.entries?.["memory-core"]?.config?.dreaming?.frequency ?? null,
    },
  };
}

// ── host-side summaries (System 2 boards, mail) ──────────────────────────────

const ITEM_STATES = {
  " ": "open",
  x: "done",
  X: "done",
  "/": "in progress",
  "~": "partial",
  ">": "claimed",
  "!": "blocked",
  "-": "cancelled",
};

export function boardSummary(swarmDir) {
  let queue;
  try {
    const st = fs.statSync(path.join(swarmDir, "queue.md"));
    if (st.size > 16 * 1024 * 1024) {
      return { error: "queue.md is larger than 16 MB" };
    }
    queue = fs.readFileSync(path.join(swarmDir, "queue.md"), "utf8");
  } catch (err) {
    return { error: `queue.md not readable (${err.code ?? err.message})` };
  }
  const counts = {};
  const open = [];
  let openTotal = 0;
  let section = "";
  for (const line of queue.split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1];
      continue;
    }
    const m = line.match(/^\s*- \[(.)\] \[([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+)\]\s*(.*)$/);
    if (!m) {
      continue;
    }
    const state = ITEM_STATES[m[1]] ?? `[${m[1]}]`;
    counts[state] = (counts[state] ?? 0) + 1;
    if (state !== "done" && state !== "cancelled" && !/^done/i.test(section)) {
      openTotal += 1;
      if (open.length < 500) {
        open.push({ id: m[2], state, section, title: m[3].replace(/\*\*/g, "").slice(0, 240) });
      }
    }
  }
  let stateUpdatedMs = null;
  try {
    stateUpdatedMs = fs.statSync(path.join(swarmDir, "state.md")).mtimeMs;
  } catch {
    stateUpdatedMs = null;
  }
  return { counts, open, openTotal, stateUpdatedMs };
}

function readEnvelopes(dir, max = 5000) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort().slice(-max);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (!st.isFile() || st.size > 1024 * 1024) continue;
      out.push(JSON.parse(fs.readFileSync(p, "utf8")));
    } catch {
      // unreadable or partial envelope — skip
    }
  }
  return out;
}

export function mailSummary(root, mailbox) {
  if (!/^[a-z0-9-]{1,40}$/.test(mailbox ?? "")) {
    return null;
  }
  const base = path.join(root, mailbox);
  if (!fs.existsSync(base)) {
    return null;
  }
  const peers = {};
  let total = 0;
  let last = null;
  const bump = (peer, direction, ts) => {
    const name = String(peer ?? "");
    if (!name || name === mailbox) return;
    peers[name] ??= { received: 0, sent: 0 };
    peers[name][direction]++;
    total++;
    if (typeof ts === "string" && (!last || ts > last)) last = ts;
  };
  for (const sub of ["inbox", "archive"]) {
    for (const env of readEnvelopes(path.join(base, sub))) bump(env.from, "received", env.ts);
  }
  for (const env of readEnvelopes(path.join(base, "sent"))) {
    for (const to of [].concat(env.to ?? [])) bump(to, "sent", env.ts);
  }
  return { peers, total, last };
}

// ── snapshot (System 3 history) ──────────────────────────────────────────────

const SNAPSHOT_PATH_RE =
  /^(?:(?:AGENTS|SOUL|TOOLS|IDENTITY|USER|HEARTBEAT|BOOTSTRAP|MEMORY|DREAMS)\.md|memory\/[A-Za-z0-9][A-Za-z0-9._-]*\.md|memory\/dreaming\/(?:light|rem|deep)\/[A-Za-z0-9][A-Za-z0-9._-]*\.md)$/;

export function isSnapshotPath(rel) {
  return typeof rel === "string" && SNAPSHOT_PATH_RE.test(rel) && !rel.split("/").some((s) => s === "." || s === "..");
}

function listFilesRecursive(dir, prefix = "") {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(dir, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(dir, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function writeIfChanged(file, content) {
  let previous = null;
  try {
    previous = fs.readFileSync(file, "utf8");
  } catch {
    previous = null;
  }
  if (previous === content) {
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  return true;
}

/** Mirror one bot's collected files into botDir. Only allowlisted relative
 *  paths are written or removed; anything else in the payload is ignored. */
export function writeBotSnapshot(botDir, { files = {}, meta = {} }) {
  fs.mkdirSync(botDir, { recursive: true, mode: 0o700 });
  const root = path.resolve(botDir);
  const keep = new Set(["meta.json"]);
  const written = [];
  const ignored = [];
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.resolve(root, rel);
    if (!isSnapshotPath(rel) || typeof content !== "string" || !dest.startsWith(`${root}${path.sep}`)) {
      ignored.push(rel);
      continue;
    }
    keep.add(rel);
    if (writeIfChanged(dest, content)) {
      written.push(rel);
    }
  }
  const metaText = `${JSON.stringify(
    {
      name: meta.name ?? null,
      createdAtMs: meta.createdAtMs ?? null,
      model: meta.model ?? null,
      dreaming: meta.dreaming ?? null,
    },
    null,
    2,
  )}\n`;
  if (writeIfChanged(path.join(root, "meta.json"), metaText)) {
    written.push("meta.json");
  }
  const removed = [];
  for (const rel of listFilesRecursive(root)) {
    if (!keep.has(rel) && isSnapshotPath(rel)) {
      fs.rmSync(path.join(root, rel));
      removed.push(rel);
    }
  }
  return { written, removed, ignored };
}

async function ensureRepo(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    await git(dir, ["init", "-q"]);
    fs.writeFileSync(
      path.join(dir, "README.md"),
      "# Fleet worldview history (CLAW-108)\n\n" +
        "Written by `scripts/claw-observatory.mjs snapshot`. One directory per bot.\n" +
        "Each commit is one night. `git log -p -- <bot>/MEMORY.md` shows how a memory changed.\n" +
        "Local only: never add a remote. These files are the bots' private memory.\n",
    );
  }
}

export async function runSnapshot({
  dir = DEFAULT_SNAPSHOT_DIR,
  commit = true,
  log = console.log,
  discover = discoverFleet,
  collectFn = (bot) => collect(bot.container, collectSnapshot, [], { timeoutMs: 120_000 }),
} = {}) {
  const fleet = await discover();
  const included = fleet.bots.filter((b) => b.running && !b.excluded);
  const skippedBots = fleet.bots.filter((b) => !b.running || b.excluded).map((b) => `${b.key} (${b.excluded ? "excluded" : b.state})`);
  await ensureRepo(dir);
  const results = [];
  let failures = 0;
  for (const bot of included) {
    try {
      const data = await collectFn(bot);
      const res = writeBotSnapshot(path.join(dir, bot.key), data);
      results.push({ key: bot.key, ...res, skipped: data.skipped ?? [] });
      log(`snapshot ${bot.key}: ${res.written.length} changed, ${res.removed.length} removed${data.skipped?.length ? `, ${data.skipped.length} skipped` : ""}`);
    } catch (err) {
      failures++;
      log(`snapshot ${bot.key}: FAILED ${err.message}`);
    }
  }
  let committed = null;
  if (commit) {
    await git(dir, ["add", "-A"]);
    const staged = (await git(dir, ["diff", "--cached", "--name-only"])).trim();
    if (staged) {
      const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      const changedBots = results.filter((r) => r.written.length || r.removed.length);
      const body = [
        ...changedBots.map((r) => `${r.key}: ${[...r.written, ...r.removed.map((f) => `-${f}`)].join(", ")}`),
        ...(skippedBots.length ? ["", `not read: ${skippedBots.join(", ")}`] : []),
        ...(failures ? ["", `failed: ${failures}`] : []),
      ].join("\n");
      await git(dir, [
        "-c", "user.name=claw-observatory",
        "-c", "user.email=claw-observatory@localhost",
        "commit", "-q", "-m", `snapshot ${stamp}`, "-m", body || "(no per-bot detail)",
      ]);
      committed = (await git(dir, ["rev-parse", "--short", "HEAD"])).trim();
      log(`committed ${committed} in ${dir}`);
    } else {
      log("no change since the last snapshot; nothing committed");
    }
  }
  return { results, failures, committed, skippedBots };
}

export function parseHistoryLog(out, prefix) {
  const commits = [];
  for (const record of String(out).split("\x1e")) {
    const lines = record.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const [sha, date, subject] = lines[0].split("\x1f");
    if (!/^[0-9a-f]{40}$/.test(sha ?? "")) continue;
    const files = [];
    for (const line of lines.slice(1)) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (m && m[3].startsWith(prefix)) {
        files.push({
          file: m[3].slice(prefix.length),
          added: m[1] === "-" ? null : Number(m[1]),
          deleted: m[2] === "-" ? null : Number(m[2]),
        });
      }
    }
    commits.push({ sha, date, subject, files });
  }
  return commits;
}

async function botHistory(dir, key) {
  if (!fs.existsSync(path.join(dir, ".git"))) {
    return { dir, commits: [] };
  }
  try {
    const out = await git(dir, ["log", "-n", "90", "--format=%x1e%H%x1f%cI%x1f%s", "--numstat", "--", `${key}/`]);
    return { dir, commits: parseHistoryLog(out, `${key}/`) };
  } catch (err) {
    // a repo with no commits yet has no HEAD
    return { dir, commits: [], note: err.message };
  }
}

async function botDiff(dir, key, commit, file) {
  if (!/^[0-9a-f]{7,40}$/.test(commit ?? "") || !(isSnapshotPath(file) || file === "meta.json")) {
    return { error: "invalid commit or file" };
  }
  const out = await git(dir, ["show", "--no-color", "--format=", "--unified=3", commit, "--", `${key}/${file}`]);
  const MAX = 600 * 1024;
  return { commit, file, truncated: out.length > MAX, diff: out.slice(0, MAX) };
}

// ── bot identities (name, emoji, avatar, role) ──────────────────────────────
// Read once per 30 minutes per bot with `docker exec` (about 3.1 s for a
// sandboxed bot), kept on disk in the state folder so the page shows every
// face at once after a restart, including a stopped bot's. A bot matched by
// the exclude pattern (see excludePattern) stays in memory only.

const IDENTITY_TTL_MS = 30 * 60 * 1000;
const IDENTITY_RETRY_MS = 2 * 60 * 1000;
const AVATAR_THUMB_PX = 160;

export function sniffImage(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** A 160 px PNG made with macOS `sips` (the avatars are about 1.1 MB each).
 *  Falls back to the original when sips is missing or fails. */
export async function avatarThumbnail(bytes, mime) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-avatar-"));
  try {
    const src = path.join(dir, "source");
    const out = path.join(dir, "thumb.png");
    fs.writeFileSync(src, bytes);
    await run("sips", ["-s", "format", "png", "-Z", String(AVATAR_THUMB_PX), src, "--out", out], { timeoutMs: 20_000 });
    const thumb = fs.readFileSync(out);
    if (sniffImage(thumb) === "image/png") return { bytes: thumb, mime: "image/png" };
  } catch {
    // fall back to the original
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return bytes.length <= 2 * 1024 * 1024 && sniffImage(bytes) ? { bytes, mime } : null;
}

const IDENTITY_KEY_RE = /^[a-z0-9-]{1,40}$/;
const AVATAR_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** In-memory identities, loaded from and saved to `dir`. */
export function identityStore(dir) {
  const mem = new Map();
  try {
    for (const name of fs.readdirSync(dir)) {
      const key = name.replace(/\.json$/, "");
      if (!name.endsWith(".json") || !IDENTITY_KEY_RE.test(key)) continue;
      try {
        const info = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        let avatar = null;
        const ext = AVATAR_EXT[info.avatarMime];
        if (ext) {
          const bytes = fs.readFileSync(path.join(dir, `${key}.${ext}`));
          if (sniffImage(bytes) === info.avatarMime) avatar = { bytes, mime: info.avatarMime, version: info.avatarVersion };
        }
        mem.set(key, { ...info, avatar, at: Date.parse(info.updatedAt) || 0 });
      } catch {
        // a damaged entry is read again from the bot
      }
    }
  } catch {
    // no cache yet
  }
  return {
    get: (key) => mem.get(key) ?? null,
    set(key, raw, avatar, { persist = true } = {}) {
      const version = avatar ? crypto.createHash("sha256").update(avatar.bytes).digest("hex").slice(0, 12) : null;
      const entry = {
        name: raw.name ?? null,
        emoji: raw.emoji ?? null,
        creature: raw.creature ?? null,
        role: raw.role ?? null,
        avatarMime: avatar?.mime ?? null,
        avatarVersion: version,
        updatedAt: new Date().toISOString(),
      };
      mem.set(key, { ...entry, avatar: avatar ? { ...avatar, version } : null, at: Date.now() });
      if (persist && IDENTITY_KEY_RE.test(key)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        for (const ext of Object.values(AVATAR_EXT)) fs.rmSync(path.join(dir, `${key}.${ext}`), { force: true });
        if (avatar) fs.writeFileSync(path.join(dir, `${key}.${AVATAR_EXT[avatar.mime]}`), avatar.bytes, { mode: 0o600 });
        fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(entry, null, 2), { mode: 0o600 });
      }
    },
    markFailed(key) {
      const entry = mem.get(key);
      mem.set(key, { ...(entry ?? { avatar: null }), at: entry?.at ?? 0, failedAt: Date.now() });
    },
  };
}

/** Start a background read of one bot's identity when the stored one is old. */
function maybeRefreshIdentity(ctx, bot) {
  if (!bot.running || ctx.identityRefreshing.has(bot.key)) return;
  const entry = ctx.identities.get(bot.key);
  const now = Date.now();
  if (entry && now - entry.at < IDENTITY_TTL_MS) return;
  if (entry?.failedAt && now - entry.failedAt < IDENTITY_RETRY_MS) return;
  ctx.identityRefreshing.add(bot.key);
  ctx
    .readIdentity(bot)
    .then(async (raw) => {
      const avatar = raw?.avatar ? await avatarThumbnail(Buffer.from(raw.avatar.b64, "base64"), raw.avatar.mime) : null;
      ctx.identities.set(bot.key, raw ?? {}, avatar, { persist: !bot.excluded });
    })
    .catch(() => ctx.identities.markFailed(bot.key))
    .finally(() => ctx.identityRefreshing.delete(bot.key));
}

/** What the page gets for one bot: name, emoji, role, color family, avatar. */
function publicIdentity(ctx, bot) {
  const entry = ctx.identities.get(bot.key);
  const role = bot.role ?? entry?.role ?? null;
  return {
    name: entry?.name ?? bot.agentName ?? null,
    emoji: entry?.emoji ?? null,
    role,
    family: roleFamily(role, entry?.creature),
    avatar: entry?.avatar ? `/api/bots/${bot.key}/avatar?v=${entry.avatar.version}` : null,
    reading: ctx.identityRefreshing.has(bot.key),
  };
}

// ── the page icon (drawn here, so the repo holds no binary) ─────────────────

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A square RGBA PNG: a dark rounded tile with three rings (the three views)
 *  around a warm center. */
export function renderIcon(size = 512) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = size / 2;
  const smooth = (edge, d) => Math.min(1, Math.max(0, edge - d + 0.5));
  const rings = [
    { r: 0.36, w: 0.035, rgb: [131, 178, 224] },
    { r: 0.26, w: 0.035, rgb: [185, 159, 226] },
    { r: 0.16, w: 0.035, rgb: [110, 199, 190] },
  ];
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const px = x + 0.5 - c;
      const py = y + 0.5 - c;
      // rounded square tile
      const half = size * 0.47;
      const radius = size * 0.2;
      const qx = Math.max(Math.abs(px) - (half - radius), 0);
      const qy = Math.max(Math.abs(py) - (half - radius), 0);
      const tile = smooth(radius, Math.hypot(qx, qy));
      let rgb = [22, 30, 42];
      const d = Math.hypot(px, py);
      for (const ring of rings) {
        const a = smooth(ring.w * size * 0.5, Math.abs(d - ring.r * size));
        rgb = rgb.map((v, i) => v + (ring.rgb[i] - v) * a);
      }
      const dot = smooth(size * 0.06, d);
      rgb = rgb.map((v, i) => v + ([240, 180, 80][i] - v) * dot);
      const o = row + 1 + x * 4;
      raw[o] = Math.round(rgb[0]);
      raw[o + 1] = Math.round(rgb[1]);
      raw[o + 2] = Math.round(rgb[2]);
      raw[o + 3] = Math.round(255 * tile);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const MANIFEST = JSON.stringify({
  name: "Fleet Observatory",
  short_name: "Observatory",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#121315",
  theme_color: "#161e2a",
  icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" }],
});

// ── user settings: USER.md for every bot, and the page's own settings ────────
// (Mike, 2026-10-08.) The settings page edits each bot's workspace/USER.md
// (who the human is; openclaw puts it in every session's prompt) and keeps a
// user profile and the background swarm's parameters in the state folder.
//
// A bot also writes its own USER.md as it learns. So the profile goes into
// one marked block, and an apply replaces only that block. A file that is
// still the blank openclaw template is replaced whole. A file with the bot's
// own notes keeps them: the block goes in under the first heading. Every
// write carries the hash of the text the page saw, and the container refuses
// it when the file changed since (the bot wrote in between). The previous
// text is kept in the state folder, which no bot mounts.

export const USER_MD_MAX = 16000;
export const USER_MD_START = "<!-- fleet-observatory:user-profile:start -->";
export const USER_MD_END = "<!-- fleet-observatory:user-profile:end -->";
const USER_MD_HISTORY_KEEP = 30;
export const PROFILE_FIELDS = [
  ["name", "Name"],
  ["callThem", "What to call them"],
  ["pronouns", "Pronouns"],
  ["timezone", "Timezone"],
  ["notes", "Notes"],
];
const PROFILE_MAX = { context: 8000 };
const SETTINGS_FILE = path.join(STATE_DIR, "settings.json");
const USER_MD_HISTORY_DIR = path.join(STATE_DIR, "user-md-history");
const SWARM_KEY_RE = /^[A-Z][A-Z0-9_]{0,40}$/;

/** Read ("read") or replace ("write") workspace/USER.md inside a bot
 *  container. A write needs the hash of the current text (or "missing"), and
 *  takes the new text as base64. Self-contained: it runs as `node -e`. */
export function collectUserMd(fs, path, home, op, baseHash, b64) {
  const MAX = 16000;
  const file = path.join(home, "workspace", "USER.md");
  // cyrb53-style hash: a change check, not a security check.
  const hash = (s) => {
    let h1 = 0xdeadbeef ^ s.length;
    let h2 = 0x41c6ce57 ^ s.length;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  };
  const read = () => {
    let st;
    try {
      st = fs.lstatSync(file);
    } catch (err) {
      if (err.code === "ENOENT") return { exists: false, text: "", hash: "missing", size: 0, mtimeMs: null };
      throw err;
    }
    if (!st.isFile()) return { error: "USER.md is not a regular file" };
    if (st.size > 256 * 1024) return { error: "USER.md is larger than 256 KB" };
    const text = fs.readFileSync(file, "utf8");
    return { exists: true, text, hash: hash(text), size: st.size, mtimeMs: st.mtimeMs };
  };
  const current = read();
  if (op !== "write" || current.error) return current;
  if (current.hash !== baseHash) return { conflict: true, ...current };
  const text = Buffer.from(String(b64 ?? ""), "base64").toString("utf8");
  if (text.length > MAX) return { error: `the new text is longer than ${MAX} characters` };
  const dir = path.dirname(file);
  if (!fs.lstatSync(dir).isDirectory()) return { error: "the workspace is not a directory" };
  const tmp = path.join(dir, `.USER.md.observatory-${Date.now()}`);
  fs.writeFileSync(tmp, text, { mode: 0o644, flag: "wx" });
  fs.renameSync(tmp, file);
  return { written: true, ...read() };
}

const profileValue = (profile, key) => String(profile?.[key] ?? "").trim();

/** The managed block: the profile fields and the context, between markers. */
export function renderProfileBlock(profile) {
  const lines = [
    USER_MD_START,
    "<!-- Written from the Fleet Observatory settings. An edit inside this block is replaced on the next apply; add your own notes outside it. -->",
    ...PROFILE_FIELDS.map(([key, label]) => `- **${label}:** ${profileValue(profile, key).replace(/\s*\n\s*/g, " ")}`.trimEnd()),
  ];
  const context = profileValue(profile, "context");
  if (context) lines.push("", "### Context", "", context);
  lines.push(USER_MD_END);
  return lines.join("\n");
}

/** True when the text is still openclaw's blank USER.md template: no field
 *  filled in, and nothing in Context but the italic prompt. */
export function isBlankUserTemplate(text) {
  if (!/^#\s*USER\.md\b/m.test(text) || text.includes(USER_MD_START)) return false;
  for (const [, label] of PROFILE_FIELDS) {
    const m = text.match(new RegExp(`^\\s*-\\s*\\*\\*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\*\\*(.*)$`, "m"));
    if (m && m[1].replace(/_\(optional\)_/i, "").trim()) return false;
  }
  const context = text.split(/^##\s*Context\s*$/m)[1]?.split(/^---\s*$/m)[0] ?? "";
  return context
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .every((l) => /^_.*_$/.test(l));
}

/** A whole USER.md for a bot that has no notes of its own yet. */
export function renderUserMd(profile) {
  return [
    "# USER.md - About Your Human",
    "",
    renderProfileBlock(profile),
    "",
    "## What I have learned",
    "",
    "_(Add what you learn about this person here, below the block above.)_",
    "",
  ].join("\n");
}

/** The new USER.md after an apply of the profile to the current text. */
export function mergeUserMd(current, profile) {
  const text = String(current ?? "");
  const block = renderProfileBlock(profile);
  const start = text.indexOf(USER_MD_START);
  const end = text.indexOf(USER_MD_END, start);
  if (start >= 0 && end > start) return text.slice(0, start) + block + text.slice(end + USER_MD_END.length);
  if (!text.trim() || isBlankUserTemplate(text)) return renderUserMd(profile);
  const heading = text.match(/^#[^#].*$/m);
  if (!heading) return `${block}\n\n${text}`;
  const at = heading.index + heading[0].length;
  return `${text.slice(0, at)}\n\n${block}\n${text.slice(at)}`;
}

/** Check a settings change from the page. Returns the clean patch, or throws
 *  with status 400. */
export function validateSettings(patch) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw bad("the body must be a JSON object");
  const out = {};
  for (const key of Object.keys(patch)) {
    if (key !== "profile" && key !== "swarm") throw bad(`unknown setting "${key}"`);
  }
  if (patch.profile !== undefined) {
    const p = patch.profile;
    if (!p || typeof p !== "object" || Array.isArray(p)) throw bad("profile must be an object");
    const allowed = new Set([...PROFILE_FIELDS.map(([k]) => k), "context"]);
    out.profile = {};
    for (const [k, v] of Object.entries(p)) {
      if (!allowed.has(k)) throw bad(`unknown profile field "${k}"`);
      if (typeof v !== "string") throw bad(`profile.${k} must be text`);
      const max = PROFILE_MAX[k] ?? 400;
      if (v.length > max) throw bad(`profile.${k} is longer than ${max} characters`);
      out.profile[k] = v;
    }
  }
  if (patch.swarm !== undefined) {
    const s = patch.swarm;
    if (s === null) {
      out.swarm = {};
    } else {
      if (typeof s !== "object" || Array.isArray(s)) throw bad("swarm must be an object or null");
      const keys = Object.keys(s);
      if (keys.length > 80) throw bad("too many swarm parameters");
      out.swarm = {};
      for (const k of keys) {
        if (!SWARM_KEY_RE.test(k)) throw bad(`bad swarm parameter name "${k}"`);
        if (typeof s[k] !== "number" || !Number.isFinite(s[k])) throw bad(`swarm.${k} must be a finite number`);
        out.swarm[k] = s[k];
      }
    }
  }
  return out;
}

/** settings.json in the state folder: { profile, swarm, updatedAt }. */
export function settingsStore(file) {
  const read = () => {
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf8"));
      return { profile: v.profile ?? {}, swarm: v.swarm ?? {}, updatedAt: v.updatedAt ?? null };
    } catch {
      return { profile: {}, swarm: {}, updatedAt: null };
    }
  };
  return {
    read,
    update(patch) {
      const next = { ...read(), ...validateSettings(patch), updatedAt: new Date().toISOString() };
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, file);
      return next;
    },
  };
}

/** Keep the text a write replaced: <dir>/<bot>/<time>.md, newest 30. */
export function keepUserMdHistory(dir, key, text) {
  const botDir = path.join(dir, key);
  fs.mkdirSync(botDir, { recursive: true, mode: 0o700 });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
  fs.writeFileSync(path.join(botDir, name), text, { mode: 0o600 });
  const all = fs.readdirSync(botDir).filter((n) => n.endsWith(".md")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - USER_MD_HISTORY_KEEP))) fs.rmSync(path.join(botDir, old));
  return name;
}

const SETTINGS_PATH_RE = /^\/api\/settings$/;
const USER_MD_PATH_RE = /^\/api\/user-md(?:\/([a-z0-9-]{1,40})(?:\/(preview))?)?$/;
const isSettingsWrite = (method, pathname) =>
  method === "PUT" && (SETTINGS_PATH_RE.test(pathname) || /^\/api\/user-md\/[a-z0-9-]{1,40}$/.test(pathname));

/** /api/settings and /api/user-md[/<bot>[/preview]]. Returns [status, json].
 *  settings          GET   { profile, swarm, updatedAt }
 *                    PUT   { profile?, swarm? }: merge and keep
 *  user-md           GET   every bot's USER.md, and the profile
 *  user-md/<bot>     PUT   { text, baseHash }: replace that bot's USER.md
 *  user-md/<bot>/preview
 *                    GET   the text an apply of the saved profile gives */
async function routeSettings(req, url, ctx) {
  if (SETTINGS_PATH_RE.test(url.pathname)) {
    if (req.method === "GET") return [200, ctx.settings.read()];
    if (req.method === "PUT") {
      let patch;
      try {
        patch = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      } catch (err) {
        if (err.status) throw err;
        return [400, { error: "the body is not valid JSON" }];
      }
      return [200, ctx.settings.update(patch)];
    }
    return [405, { error: "method not allowed here" }];
  }
  const [, key, sub] = USER_MD_PATH_RE.exec(url.pathname) ?? [];
  const fleet = await cached(ctx, "fleet", 4000, ctx.discover);
  if (!key) {
    if (req.method !== "GET") return [405, { error: "method not allowed here" }];
    const bots = await Promise.all(
      fleet.bots.map(async (bot) => {
        const base = { key: bot.key, running: bot.running, state: bot.state };
        if (!bot.running) return { ...base, error: `${bot.container} is ${bot.state}` };
        try {
          return { ...base, ...(await ctx.readUserMd(bot)) };
        } catch (err) {
          return { ...base, error: err.message };
        }
      }),
    );
    return [200, { profile: ctx.settings.read().profile, bots }];
  }
  const bot = fleet.bots.find((b) => b.key === key);
  if (!bot) return [404, { error: `unknown bot "${key}"` }];
  if (!bot.running) return [409, { error: `${bot.container} is ${bot.state}` }];
  if (sub === "preview") {
    if (req.method !== "GET") return [405, { error: "method not allowed here" }];
    const current = await ctx.readUserMd(bot);
    if (current.error) return [409, { error: current.error }];
    return [200, { text: mergeUserMd(current.text, ctx.settings.read().profile), baseHash: current.hash }];
  }
  if (req.method !== "PUT") return [405, { error: "method not allowed here" }];
  let body;
  try {
    body = JSON.parse((await readBody(req, 128 * 1024)).toString("utf8"));
  } catch (err) {
    if (err.status) throw err;
    return [400, { error: "the body is not valid JSON" }];
  }
  if (typeof body?.text !== "string") return [400, { error: "text must be a string" }];
  if (typeof body.baseHash !== "string" || !/^(missing|[0-9a-f]{16})$/.test(body.baseHash)) return [400, { error: "baseHash is missing or malformed" }];
  if (body.text.length > USER_MD_MAX) return [413, { error: `USER.md is limited to ${USER_MD_MAX} characters` }];
  const before = await ctx.readUserMd(bot);
  if (before.error) return [409, { error: before.error }];
  const result = await ctx.writeUserMd(bot, body.baseHash, body.text);
  if (result.error) return [409, { error: result.error }];
  if (result.conflict) {
    const { conflict: _c, ...current } = result;
    return [409, { error: `${bot.key} changed its USER.md after this page read it. Reload, then apply again.`, current }];
  }
  // The text this write replaced. Taken from the read just before the write;
  // the container compared hashes, so it is the text that was replaced.
  if (before.exists && before.hash === body.baseHash) ctx.keepUserMdHistory(bot.key, before.text);
  return [200, result];
}

// ── observatory HTTP server ──────────────────────────────────────────────────

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const WRITE_METHODS = new Set(["POST", "PUT", "DELETE"]);
const isFeedbackPath = (pathname) => pathname === "/api/feedback" || pathname.startsWith("/api/feedback/");
const CONTROL_UI_PATH_RE = /^\/api\/control-ui\/([a-z0-9-]{1,40})\/(open|approve|pairing)$/;
const isControlUiWrite = (pathname) => ["open", "approve"].includes(CONTROL_UI_PATH_RE.exec(pathname)?.[2]);

/** Refuse anything that did not come from a page this server served on
 *  loopback. Returns null when the request may proceed. */
export function checkRequest(req, port) {
  const host = String(req.headers.host ?? "").toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { status: 421, error: "wrong Host header" };
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
    return { status: 403, error: "foreign Origin" };
  }
  if (req.method === "GET" || req.method === "HEAD") {
    return null;
  }
  const pathname = String(req.url ?? "").split("?")[0];
  if (!WRITE_METHODS.has(req.method) || !(isFeedbackPath(pathname) || isControlUiWrite(pathname) || isSettingsWrite(req.method, pathname))) {
    return { status: 405, error: "read-only" };
  }
  // A browser always sends Origin with a POST, PUT or DELETE fetch. A write
  // without one did not come from this page.
  if (origin === undefined) {
    return { status: 403, error: "a write needs this page's Origin" };
  }
  return null;
}

export function tokenMatches(req, token) {
  const got = Buffer.from(String(req.headers["x-observatory-token"] ?? ""));
  const want = Buffer.from(String(token));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function send(res, status, body, type) {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type });
  res.end(body);
}

const sendJson = (res, status, value) => send(res, status, JSON.stringify(value), "application/json; charset=utf-8");

/** Share one read per key. A read still in flight is always shared: a docker
 *  exec can take seconds on a busy fleet, and a second exec started behind a
 *  slow one only makes both slower. The TTL counts from when the read settles;
 *  a failed read is not kept. */
export function cached(ctx, key, ttlMs, fn) {
  const hit = ctx.cache.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < ttlMs)) {
    return hit.promise;
  }
  const entry = { at: Date.now(), pending: true, promise: null };
  entry.promise = fn().then(
    (value) => {
      entry.pending = false;
      entry.at = Date.now();
      return value;
    },
    (err) => {
      if (ctx.cache.get(key) === entry) {
        ctx.cache.delete(key);
      }
      throw err;
    },
  );
  ctx.cache.set(key, entry);
  return entry.promise;
}

function httpReachable(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

const pickItem = (i) => ({
  id: i.id ?? null,
  // dot_swarm WorkItem carries the item text in "description"
  title: i.description ?? i.title ?? null,
  state: i.state ?? null,
  priority: i.priority ?? null,
  project: i.project ?? null,
  claimedBy: i.claimed_by ?? null,
  claimedAt: i.claimed_at ?? null,
});

// ── the colony: every .swarm division under the dot_swarm root ──────────────
// Read by calling dot_swarm's own get_colony_summary() with the dot_swarm
// venv's Python, not through the dashboard's HTTP API: the page must show the
// colony even when the dashboard is not running.

const COLONY_SNIPPET = [
  "import json, sys",
  "from pathlib import Path",
  "from dot_swarm.operations import get_colony_summary",
  "print(json.dumps(get_colony_summary(Path(sys.argv[1]))))",
].join("\n");

export function swarmPython(env = process.env) {
  if (env.OASIS_SWARM_PYTHON) return env.OASIS_SWARM_PYTHON;
  if (env.OASIS_SWARM_BIN) return path.join(path.dirname(env.OASIS_SWARM_BIN), "python");
  return "python3";
}

export async function readColony(root, python = swarmPython()) {
  return JSON.parse(await run(python, ["-c", COLONY_SNIPPET, root], { timeoutMs: 120_000 }));
}

// ── the dot_swarm dashboard, started beside the observatory ────────────────
// History: until dot_swarm's 2026-09-28 fix, `swarm gui` served its write
// token inside GET /, needed no token for a read, and accepted a write with no
// Origin. Docker Desktop forwards host.docker.internal to the Mac's loopback,
// so Nimbus and Hello World could read every board and write to it as the
// human (measured 2026-09-22, CLAW-108 §5 item 6). The fixed dashboard needs
// its token on every /api/ route, and takes the token from SWARM_GUI_TOKEN.
// verifySwarmDashboard() proves that fixed behavior before the page links to
// the dashboard; an older dot_swarm is stopped at once.

/** GET a loopback URL; resolve { status, body } or null if unreachable. */
function httpGet(url, headers = {}, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size <= 4 * 1024 * 1024) chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

/** Resolve null when the dashboard at `url` has the fixed token behavior,
 *  or a reason string when it does not. */
export async function verifySwarmDashboard(url, token) {
  const page = await httpGet(url);
  if (!page || page.status !== 200) return `GET / answered ${page ? page.status : "nothing"}`;
  if (page.body.includes(token)) return "GET / hands out the session token (dot_swarm older than the 2026-09-28 fix)";
  const anon = await httpGet(new URL("/api/state.json", url).href);
  if (!anon || anon.status !== 401) {
    return `GET /api/state.json without the token answered ${anon ? anon.status : "nothing"}, not 401 (dot_swarm older than the 2026-09-28 fix)`;
  }
  const authed = await httpGet(new URL("/api/state.json", url).href, { "X-Swarm-Token": token }, 120_000);
  if (!authed || authed.status !== 200) return `GET /api/state.json with the token answered ${authed ? authed.status : "nothing"}`;
  return null;
}

/**
 * Start `swarm gui` on 127.0.0.1:port with a fresh token, and verify it.
 * Resolves one of:
 *   { state: "managed", url, openUrl, stop() }   started and verified
 *   { state: "foreign", url }                    the port already answers; not ours
 *   { state: "failed",  url, reason }            not started, or stopped again
 */
export async function startSwarmDashboard({
  bin,
  root,
  port = SWARM_PORT,
  token = crypto.randomBytes(32).toString("base64url"),
  env = process.env,
  timeoutMs = 20_000,
} = {}) {
  const url = `http://127.0.0.1:${port}/`;
  if (await httpReachable(url)) return { state: "foreign", url };

  let child;
  try {
    child = spawn(bin, ["--path", root, "gui", "--port", String(port)], {
      env: { ...env, SWARM_GUI_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return { state: "failed", url, reason: `cannot start ${bin}: ${err.message}` };
  }
  // Keep only the last lines, for an error report. The dashboard prints its
  // own token URL; this process never echoes it.
  const tail = [];
  const keep = (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim() && !line.includes(token)) tail.push(line.trim());
    }
    tail.splice(0, Math.max(0, tail.length - 5));
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  let exited = null;
  child.on("exit", (code, signal) => {
    exited = signal ?? `exit ${code}`;
  });
  child.on("error", (err) => {
    exited = err.message;
  });

  const stop = () => {
    if (exited === null) child.kill("SIGTERM");
  };
  const fail = (reason) => {
    stop();
    return { state: "failed", url, reason: tail.length ? `${reason} — ${tail.join(" | ")}` : reason };
  };

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited !== null) return fail(`${bin} stopped (${exited})`);
    const page = await httpGet(url, {}, 1000);
    if (page?.status === 200) break;
    if (Date.now() > deadline) return fail(`no answer on ${url} after ${timeoutMs / 1000} s`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const refused = await verifySwarmDashboard(url, token);
  if (refused) return fail(`not linked: ${refused}`);
  return { state: "managed", url, openUrl: `${url}#t=${token}`, stop, child };
}

async function lastSnapshotCommit(dir) {
  if (!fs.existsSync(path.join(dir, ".git"))) return null;
  try {
    const [sha, date, subject] = (await git(dir, ["log", "-1", "--format=%h%x1f%cI%x1f%s"])).trim().split("\x1f");
    return sha ? { sha, date, subject } : null;
  } catch {
    return null;
  }
}

/** Read a request body of at most maxBytes. */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(Object.assign(new Error(`the body is larger than ${maxBytes} bytes`), { status: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        reject(Object.assign(new Error(`the body is larger than ${maxBytes} bytes`), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!failed) reject(err);
    });
  });
}

const FEEDBACK_JSON_MAX = 32 * 1024;
const FEEDBACK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Open the feedback store on first use. */
export function lazyFeedbackStore(dir = DEFAULT_FEEDBACK_DIR) {
  let opening = null;
  return () => (opening ??= import(FEEDBACK_MODULE.href).then((m) => m.openFeedbackStore(dir)));
}

// ── feedback to the bots (Mike, 2026-10-07, R5) ──────────────────────────────
// A submitted change request goes, as console mail, to the bots it names. The
// default is the primary Oasis-X bots. The envelope is the one that
// claw-mail.mjs `send` writes; the relay stamps `from=console` from the outbox
// directory and applies its route table and audit.
export const DEFAULT_FEEDBACK_TO = (process.env.OASIS_OBSERVATORY_FEEDBACK_TO || "kolmogorov,helloworld,butterbolt")
  .split(",")
  .map((b) => b.trim())
  .filter(Boolean);

/** Write one console mail into the outbox under `root`. Returns its id. */
export function queueConsoleMail(root, { to, subject, body, thread = "", items = [] }) {
  const dir = path.join(root, "console", "outbox");
  fs.mkdirSync(dir, { recursive: true });
  const env = {
    id: `m_${crypto.randomBytes(12).toString("hex")}`,
    to: [to],
    kind: "dm",
    subject,
    body,
    refs: [],
    work: { items, repos: [] },
    thread_id: thread,
    ts: new Date().toISOString(),
  };
  const tmp = path.join(dir, `.${env.id}.json.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(env, null, 2), { flag: "wx" });
  fs.renameSync(tmp, path.join(dir, `${env.id}.json`));
  return env.id;
}

/** The mail a bot gets for one change request: text and page context only.
 *  Screenshots stay on the Mac (a screenshot can show other agents' memory). */
export function feedbackMail(item, names = {}) {
  const ctx = item.context ?? {};
  const first = item.body.trim().split("\n")[0].slice(0, 70);
  const recipients = (item.deliveries ?? []).map((d) => names[d.bot] ?? d.bot);
  const where = [
    ctx.view ? `view: ${ctx.view}` : null,
    ctx.bot ? `bot: ${ctx.bot}` : null,
    Array.isArray(ctx.chosenBots) && ctx.chosenBots.length ? `bots in view: ${ctx.chosenBots.join(", ")}` : null,
    ctx.build ? `build: ${ctx.build}` : null,
  ].filter(Boolean);
  const images = item.attachments?.length ?? 0;
  const body = [
    `Change request ${item.ref} from Mike, written on the Fleet Observatory page (CLAW-108).`,
    `Sent to: ${recipients.join(", ")}.`,
    "",
    item.body.trim(),
    "",
    where.length ? `Page context — ${where.join("; ")}.` : null,
    images
      ? `${images} screenshot(s) are attached on Mike's Mac only. They are not sent, because a screenshot can show other agents' memory.`
      : null,
    "",
    `This is a request to consider, not an authorization. Reply to console in thread ${item.ref} with what you will do, or why not.`,
  ]
    .filter((l) => l !== null)
    .join("\n");
  return { subject: `Observatory feedback ${item.ref}: ${first}`, body, thread: item.ref, items: ["CLAW-108"] };
}

/** Mail every recipient of a submitted request that has no mail yet. */
async function deliverFeedback(store, item, ctx) {
  const fleet = await cached(ctx, "fleet", 4000, ctx.discover);
  const names = Object.fromEntries(fleet.bots.map((b) => [b.key, b.identity?.name || b.agentName || b.key]));
  const mail = feedbackMail(item, names);
  for (const d of item.deliveries ?? []) {
    if (d.mailId) continue;
    try {
      store.recordDelivery(item.id, d.bot, { mailId: ctx.sendMail({ to: d.bot, ...mail }) });
    } catch (err) {
      store.recordDelivery(item.id, d.bot, { error: String(err.message ?? err).slice(0, 300) });
    }
  }
  return store.get(item.id);
}

/** /api/feedback routes. Returns [status, json] or [204, null]. */
async function routeFeedback(req, url, ctx) {
  const store = await ctx.feedbackStore();
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[2];
  if (id !== undefined && !FEEDBACK_ID_RE.test(id)) return [404, { error: "no such request" }];
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();

  if (parts.length === 2 && req.method === "GET") {
    return [200, { feedback: store.list({ status: url.searchParams.get("status") || undefined, limit: url.searchParams.get("limit") || 20 }).map(publicItem) }];
  }
  if (parts.length === 2 && req.method === "POST") {
    if (type !== "application/json") return [415, { error: "send application/json" }];
    let input;
    try {
      input = JSON.parse((await readBody(req, FEEDBACK_JSON_MAX)).toString("utf8"));
    } catch (err) {
      if (err.status) throw err;
      return [400, { error: "the body is not valid JSON" }];
    }
    // The server adds what the page cannot know (the build). The size limit
    // applies to the page's part only.
    const fleet = await cached(ctx, "fleet", 4000, ctx.discover);
    const created = store.create(input, {
      author: ctx.author ?? null,
      extra: ctx.build ? { build: ctx.build } : {},
      defaultTo: ctx.feedbackTo.filter((b) => fleet.bots.some((x) => x.key === b)),
      knownBots: fleet.bots.map((b) => b.key),
    });
    return [201, created];
  }
  if (parts.length === 3 && req.method === "GET") {
    return [200, publicItem(store.get(id))];
  }
  if (parts.length === 3 && req.method === "DELETE") {
    store.withdraw(id);
    return [204, null];
  }
  if (parts.length === 4 && parts[3] === "submit" && req.method === "POST") {
    const submitted = store.submit(id);
    return [200, publicItem(submitted.status === "new" ? await deliverFeedback(store, submitted, ctx) : submitted)];
  }
  if (parts.length === 5 && parts[3] === "files" && req.method === "PUT") {
    if (!/^[1-9]$/.test(parts[4])) return [404, { error: "no such image slot" }];
    const data = await readBody(req, ctx.maxImageBytes ?? 10 * 1024 * 1024);
    store.storeFile(id, Number(parts[4]), type, data);
    return [204, null];
  }
  return [405, { error: "method not allowed here" }];
}

// The page never needs where an image lies on the Mac.
const publicItem = (item) => ({
  ...item,
  attachments: item.attachments.map(({ path: _hidden, ...rest }) => rest),
});

/** /api/control-ui/<bot>/{open,pairing,approve}. Returns [status, json].
 *  open      POST  the signed-in address, and start the pairing window
 *  pairing   GET   pending Control UI requests for this bot, judged
 *  approve   POST  {requestId}: pair that browser (judged again here) */
async function routeControlUi(req, url, ctx) {
  const [, key, action] = CONTROL_UI_PATH_RE.exec(url.pathname) ?? [];
  if (!key) return [404, { error: "not found" }];
  const fleet = await cached(ctx, "fleet", 4000, ctx.discover);
  const bot = fleet.bots.find((b) => b.key === key);
  if (!bot) return [404, { error: `unknown bot "${key}"` }];
  if (!bot.running) return [409, { error: `${bot.container} is ${bot.state}` }];
  const judge = (r) => judgeControlUiRequest(r, { proxyAddresses: fleet.proxy?.addresses ?? [], armedAt: ctx.pairingArmed.get(key) ?? null });

  if (action === "open" && req.method === "POST") {
    const { mode, token } = await ctx.readGatewayToken(bot);
    if (mode !== "token") return [409, { error: `${bot.key}: gateway auth mode is ${mode ?? "unknown"}, not token` }];
    const openUrl = controlUiSignedInUrl(bot, { proxyKey: ctx.proxyKey(), gatewayToken: token });
    if (!openUrl) return [409, { error: `${bot.key} has no reachable Control UI (${bot.controlUi.via})` }];
    ctx.pairingArmed.set(key, Date.now());
    return [200, { url: openUrl }];
  }
  if (action === "pairing" && req.method === "GET") {
    const pending = await ctx.readPendingPairing(bot);
    return [
      200,
      {
        pending: pending
          .filter((r) => r.clientId === CONTROL_UI_CLIENT)
          .map((r) => ({
            requestId: r.requestId,
            platform: r.platform ?? null,
            remoteIp: r.remoteIp ?? null,
            scopes: r.scopes ?? [],
            ts: r.ts ?? null,
            ...judge(r),
          })),
      },
    ];
  }
  if (action === "approve" && req.method === "POST") {
    let requestId;
    try {
      requestId = JSON.parse((await readBody(req, 1024)).toString("utf8")).requestId;
    } catch (err) {
      if (err.status) throw err;
      return [400, { error: "the body is not valid JSON" }];
    }
    if (!REQUEST_ID_RE.test(String(requestId ?? ""))) return [400, { error: "invalid request id" }];
    const request = (await ctx.readPendingPairing(bot)).find((r) => r.requestId === requestId);
    if (!request) return [404, { error: "no such pending request" }];
    const verdict = judge(request);
    if (!verdict.ok) return [403, { error: verdict.reason }];
    await ctx.approveDevice(bot.container, requestId);
    return [200, { approved: requestId }];
  }
  return [405, { error: "method not allowed here" }];
}

async function routeApi(url, ctx) {
  const parts = url.pathname.split("/").filter(Boolean);
  const fleet = () => cached(ctx, "fleet", 4000, ctx.discover);

  if (parts.length === 2 && parts[1] === "fleet") {
    const [f, swarmUp, snapshot] = await Promise.all([
      fleet(),
      cached(ctx, "swarm-up", 5000, () => httpReachable(ctx.swarm.url)),
      cached(ctx, "snapshot-last", 30_000, () => lastSnapshotCommit(ctx.snapshotDir)),
    ]);
    for (const b of f.bots) maybeRefreshIdentity(ctx, b);
    const withUrls = withOpenUrls(f, ctx.proxyKey());
    return [
      200,
      {
        ...withUrls,
        bots: withUrls.bots.map((b) => ({ ...b, identity: publicIdentity(ctx, b) })),
        families: [...ROLE_FAMILIES.map(({ id, label }) => ({ id, label })), OTHER_FAMILY],
        swarm: { ...ctx.swarm, running: swarmUp },
        feedback: { defaultTo: ctx.feedbackTo },
        snapshot: { dir: ctx.snapshotDir, last: snapshot },
      },
    ];
  }

  if (parts.length === 2 && parts[1] === "colony") {
    const raw = await cached(ctx, "colony", 60_000, () => ctx.readColony());
    return [
      200,
      {
        url: ctx.swarm.url,
        root: raw.root ?? null,
        timestamp: raw.timestamp ?? null,
        divisions: (raw.divisions ?? []).map((d) => ({
          name: d.name ?? null,
          path: d.path ?? null,
          error: d.error ?? null,
          active: d.queue?.active?.length ?? 0,
          pending: d.queue?.pending?.length ?? 0,
          done: d.queue?.done?.length ?? 0,
          items: [...(d.queue?.active ?? []), ...(d.queue?.pending ?? [])].slice(0, 40).map(pickItem),
        })),
      },
    ];
  }

  if (parts.length === 2 && parts[1] === "boards") {
    const f = await fleet();
    const boards = f.bots
      .filter((b) => b.board?.hostPath)
      .map((b) => ({ key: b.key, container: b.container, hostPath: b.board.hostPath, summary: boardSummary(b.board.hostPath) }));
    return [200, { boards }];
  }

  if (parts.length === 4 && parts[1] === "bots") {
    const f = await fleet();
    const bot = f.bots.find((b) => b.key === parts[2]);
    if (!bot) return [404, { error: "unknown bot" }];
    const needsContainer = ["profile", "sessions", "transcript"].includes(parts[3]);
    if (needsContainer && !bot.running) return [409, { error: `${bot.container} is ${bot.state}` }];

    switch (parts[3]) {
      case "profile": {
        const profile = await cached(ctx, `profile:${bot.key}`, 60_000, () => collect(bot.container, collectProfile));
        return [
          200,
          {
            bot,
            profile,
            mail: bot.mailbox ? mailSummary(ctx.mailRoot, bot.mailbox) : null,
            board: bot.board?.hostPath ? { hostPath: bot.board.hostPath, summary: boardSummary(bot.board.hostPath) } : null,
          },
        ];
      }
      case "sessions":
        return [200, await cached(ctx, `sessions:${bot.key}`, 5000, () => collect(bot.container, collectSessions))];
      case "transcript": {
        const agent = url.searchParams.get("agent") || "main";
        const session = url.searchParams.get("session") || "";
        const limit = url.searchParams.get("limit") || "150";
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(agent) || !/^[0-9a-f-]{8,64}$/i.test(session) || !/^\d{1,3}$/.test(limit)) {
          return [400, { error: "invalid agent, session or limit" }];
        }
        const result = await cached(ctx, `transcript:${bot.key}:${agent}:${session}:${limit}`, 2500, () =>
          collect(bot.container, collectTranscript, [agent, session, limit]),
        );
        return [result.error ? 404 : 200, result];
      }
      case "history":
        return [200, await botHistory(ctx.snapshotDir, bot.key)];
      case "diff": {
        const result = await botDiff(ctx.snapshotDir, bot.key, url.searchParams.get("commit"), url.searchParams.get("file"));
        return [result.error ? 400 : 200, result];
      }
      default:
        return [404, { error: "not found" }];
    }
  }
  return [404, { error: "not found" }];
}

let pageIcon = null;

export function createObservatoryServer(ctx) {
  ctx.cache ??= new Map();
  ctx.discover ??= discoverFleet;
  ctx.mailRoot ??= MAIL_ROOT;
  ctx.snapshotDir ??= DEFAULT_SNAPSHOT_DIR;
  ctx.proxyKey ??= () => ensureProxyKey();
  ctx.pairingArmed ??= new Map();
  ctx.readGatewayToken ??= (bot) => collect(bot.container, collectGatewayToken);
  ctx.readPendingPairing ??= (bot) => collect(bot.container, collectPendingPairing);
  ctx.approveDevice ??= (container, requestId) =>
    docker(["exec", container, "openclaw", "devices", "approve", requestId, "--json"], { timeoutMs: 30_000 });
  ctx.feedbackStore ??= lazyFeedbackStore();
  ctx.feedbackTo ??= DEFAULT_FEEDBACK_TO;
  ctx.sendMail ??= (mail) => queueConsoleMail(ctx.mailRoot, mail);
  ctx.identities ??= identityStore(IDENTITY_DIR);
  ctx.identityRefreshing ??= new Set();
  ctx.readIdentity ??= (bot) => collect(bot.container, collectIdentity);
  ctx.readColony ??= () => readColony(ctx.swarm.root);
  ctx.settings ??= settingsStore(SETTINGS_FILE);
  ctx.readUserMd ??= (bot) => collect(bot.container, collectUserMd, ["read"]);
  ctx.writeUserMd ??= (bot, baseHash, text) =>
    collect(bot.container, collectUserMd, ["write", baseHash, Buffer.from(text, "utf8").toString("base64")]);
  ctx.keepUserMdHistory ??= (key, text) => keepUserMdHistory(USER_MD_HISTORY_DIR, key, text);
  return http.createServer((req, res) => {
    const refused = checkRequest(req, ctx.port);
    if (refused) {
      sendJson(res, refused.status, { error: refused.error });
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${ctx.port}`);
    const asset = ASSETS[url.pathname];
    if (asset) {
      fs.readFile(path.join(ctx.assetDir ?? ASSET_DIR, asset[0]), (err, body) => {
        if (err) send(res, 500, "asset missing", "text/plain; charset=utf-8");
        else send(res, 200, body, asset[1]);
      });
      return;
    }
    if (url.pathname === "/icon.png") {
      pageIcon ??= renderIcon(512);
      res.writeHead(200, { ...SECURITY_HEADERS, "cache-control": "public, max-age=86400", "content-type": "image/png" });
      res.end(pageIcon);
      return;
    }
    if (url.pathname === "/manifest.webmanifest") {
      send(res, 200, MANIFEST, "application/manifest+json");
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (!tokenMatches(req, ctx.token)) {
      sendJson(res, 401, { error: "this browser has no valid access key: run `make observe-open` once" });
      return;
    }
    const avatarMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]{1,40})\/avatar$/);
    if (avatarMatch) {
      const avatar = ctx.identities.get(avatarMatch[1])?.avatar;
      if (!avatar) {
        sendJson(res, 404, { error: "no avatar" });
        return;
      }
      // The URL carries the image version, so the browser may keep it.
      res.writeHead(200, { ...SECURITY_HEADERS, "cache-control": "private, max-age=86400", "content-type": avatar.mime });
      res.end(avatar.bytes);
      return;
    }
    if (isFeedbackPath(url.pathname)) {
      routeFeedback(req, url, ctx).then(
        ([status, body]) => {
          if (body === null) {
            res.writeHead(status, SECURITY_HEADERS);
            res.end();
          } else {
            sendJson(res, status, body);
          }
        },
        (err) => {
          // Stop reading a body that was refused part-way.
          if (err.status === 413) res.once("finish", () => req.destroy());
          sendJson(res, err.status ?? 500, { error: err.message });
        },
      );
      return;
    }
    if (SETTINGS_PATH_RE.test(url.pathname) || USER_MD_PATH_RE.test(url.pathname)) {
      routeSettings(req, url, ctx).then(
        ([status, body]) => sendJson(res, status, body),
        (err) => {
          if (err.status === 413) res.once("finish", () => req.destroy());
          sendJson(res, err.status ?? 502, { error: err.message });
        },
      );
      return;
    }
    if (CONTROL_UI_PATH_RE.test(url.pathname)) {
      routeControlUi(req, url, ctx).then(
        ([status, body]) => sendJson(res, status, body),
        (err) => sendJson(res, err.status ?? 502, { error: err.message }),
      );
      return;
    }
    routeApi(url, ctx).then(
      ([status, body]) => sendJson(res, status, body),
      (err) => sendJson(res, 502, { error: err.message }),
    );
  });
}

// ── commands ─────────────────────────────────────────────────────────────────

function openInBrowser(url) {
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.on("error", () => console.error(`could not run \`open\`; visit ${url.replace(/#.*$/, "")} by hand`));
  child.unref();
}

function readServeFile() {
  try {
    const info = JSON.parse(fs.readFileSync(SERVE_FILE, "utf8"));
    process.kill(info.pid, 0);
    return info;
  } catch {
    return null;
  }
}

const pad = (s, n) => String(s).padEnd(n);

async function cmdList(flags) {
  const fleet = await discoverFleet();
  if (flags.json) {
    console.log(JSON.stringify(fleet, null, 2));
    return;
  }
  console.log(`${pad("BOT", 12)} ${pad("STATE", 18)} ${pad("CONTROL UI", 34)} BOARD`);
  for (const b of fleet.bots) {
    const state = b.health ? `${b.state}/${b.health}` : b.state;
    const ui = b.controlUi.url ? `${b.controlUi.url}${b.controlUi.via === "proxy" ? " (proxy)" : ""}` : `— ${b.controlUi.via}`;
    console.log(`${pad(b.key, 12)} ${pad(state + (b.excluded ? " *" : ""), 18)} ${pad(ui, 34)} ${b.board?.hostPath ?? "—"}`);
  }
  const proxy = fleet.proxy ? `${fleet.proxy.state}${fleet.proxy.health ? `/${fleet.proxy.health}` : ""}, ${fleet.proxy.routes.length} routes` : "not created";
  console.log(`\nport proxy: ${proxy}`);
  if (fleet.bots.some((b) => b.excluded)) console.log("* excluded from snapshots (OASIS_OBSERVATORY_EXCLUDE)");
  const serve = readServeFile();
  console.log(serve ? `observatory: http://127.0.0.1:${serve.port}/ (pid ${serve.pid}; \`make observe-open\` unlocks a browser)` : "observatory: not running (`make observatory` starts it)");
  if (fleet.bots.some((b) => !b.controlUi.url && b.running)) {
    console.log("a bot with no Control UI address needs the port proxy: `cd bots && make observatory-proxy-up`");
  }
}

async function cmdOpen(target) {
  if (target === "observatory") {
    const serve = readServeFile();
    if (!serve) throw new Error("the observatory is not running; start it with `make observatory`");
    // The page moves the key from the fragment (never sent to a server) into
    // its localStorage, then removes it from the address bar.
    openInBrowser(`http://127.0.0.1:${serve.port}/#t=${ensureKey(OBSERVATORY_KEY_FILE)}`);
    console.log(`opened http://127.0.0.1:${serve.port}/ — this browser is now unlocked; bookmark that address`);
    return;
  }
  if (target === "board") {
    const serve = readServeFile();
    if (!serve?.swarmOpenUrl) {
      throw new Error(
        "the observatory is not running a swarm dashboard; start it with `make observatory`, " +
          "or run `make swarm-dashboard` and open the URL it prints",
      );
    }
    // The token is in the fragment, which the browser never sends; the
    // dashboard page moves it into sessionStorage and clears the address bar.
    openInBrowser(serve.swarmOpenUrl);
    console.log(`opened ${new URL(serve.swarmOpenUrl).origin}/ (swarm dashboard)`);
    return;
  }
  const fleet = await discoverFleet();
  const bot = fleet.bots.find((b) => b.key === target || b.container === target);
  if (!bot) throw new Error(`unknown bot "${target}"; known: ${fleet.bots.map((b) => b.key).join(", ")}`);
  if (!bot.controlUi.url) throw new Error(`${bot.key} has no reachable Control UI (${bot.controlUi.via}); start the port proxy`);
  // A proxied UI opens through the proxy's unlock page, which sets the access
  // cookie for this browser and then loads the UI.
  openInBrowser(withOpenUrls({ bots: [bot] }, ensureProxyKey()).bots[0].controlUi.openUrl);
  console.log(`opened ${bot.controlUi.url}  — first visit asks for the gateway token, then device pairing: \`make pair BOT=${bot.key}\``);
}

async function cmdPair(target, flags) {
  const fleet = await discoverFleet();
  const bot = fleet.bots.find((b) => b.key === target || b.container === target);
  if (!bot) throw new Error(`unknown bot "${target}"`);
  if (!bot.running) throw new Error(`${bot.container} is ${bot.state}`);
  if (flags.approve) {
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(flags.approve)) throw new Error("invalid request id");
    const out = await docker(["exec", bot.container, "openclaw", "devices", "approve", flags.approve, "--json"], { timeoutMs: 30_000 });
    console.log(out.trim());
    return;
  }
  const { pending, paired } = await listDevices(bot.container);
  console.log(`${bot.key}: ${paired.length} paired (${paired.map((d) => d.clientId ?? "?").join(", ") || "none"}), ${pending.length} pending`);
  for (const p of pending) {
    const fields = ["requestId", "clientId", "clientMode", "platform", "displayName", "remoteIp"]
      .filter((k) => p[k] != null)
      .map((k) => `${k}=${p[k]}`);
    const age = typeof p.ts === "number" ? p.ts : p.createdAtMs;
    console.log(`  ${fields.join("  ")}${age ? `  requested ${new Date(age).toLocaleString()}` : ""}`);
  }
  if (pending.length) {
    console.log(`approve one you just requested: make pair BOT=${bot.key} ID=<requestId>`);
  }
}

/** The commit this page runs from, and whether its own files have local
 *  changes. A change request records it. */
async function buildLabel() {
  const repo = path.resolve(SCRIPT_DIR, "..");
  try {
    const sha = (await git(repo, ["rev-parse", "--short", "HEAD"], { timeoutMs: 5000 })).trim();
    const own = ["scripts/claw-observatory.mjs", "scripts/claw-observatory-feedback.mjs", "scripts/observatory"];
    const dirty = (await git(repo, ["status", "--porcelain", "--", ...own], { timeoutMs: 10_000 })).trim();
    return dirty ? `${sha}+local-changes` : sha;
  } catch {
    return null;
  }
}

async function proxyState() {
  try {
    const out = await docker(["ps", "-a", "--filter", `name=^${PROXY_CONTAINER}$`, "--format", "{{.State}}"], { timeoutMs: 10_000 });
    return out.trim() || "not created";
  } catch {
    return "unknown (docker did not answer)";
  }
}

async function cmdServe(flags) {
  const port = flags.port ?? DEFAULT_PORT;
  // A stable key, so the bookmark http://127.0.0.1:<port>/ keeps working. The
  // page keeps it in localStorage, which belongs to this one origin. It is not
  // a cookie on purpose: a cookie is not limited to one port, so the browser
  // would also send it to 127.0.0.1:18789, Nimbus's gateway, and Nimbus is the
  // bot that can reach this server (through host.docker.internal).
  const token = ensureKey(OBSERVATORY_KEY_FILE);
  const swarm = {
    port: SWARM_PORT,
    url: `http://127.0.0.1:${SWARM_PORT}/`,
    root: process.env.OASIS_SWARM_ROOT || path.resolve(SCRIPT_DIR, "..", ".."),
    managed: false,
    openUrl: null,
    note: flags.noDashboard ? "not started (--no-dashboard)" : null,
  };
  let dashboard = null;
  if (!flags.noDashboard) {
    dashboard = await startSwarmDashboard({
      bin: process.env.OASIS_SWARM_BIN || "swarm",
      root: swarm.root,
      port: SWARM_PORT,
    });
    if (dashboard.state === "managed") {
      swarm.managed = true;
      swarm.openUrl = dashboard.openUrl;
      dashboard.child.on("exit", (code, signal) => {
        swarm.openUrl = null;
        swarm.managed = false;
        swarm.note = `stopped (${signal ?? `exit ${code}`}); restart the observatory`;
        console.error(`swarm dashboard: ${swarm.note}`);
      });
    } else if (dashboard.state === "foreign") {
      swarm.note = "started outside the observatory: open the URL that its own terminal printed";
    } else {
      swarm.note = dashboard.reason;
    }
  }
  const ctx = {
    port,
    token,
    swarm,
    snapshotDir: flags.dir ?? DEFAULT_SNAPSHOT_DIR,
    mailRoot: MAIL_ROOT,
    author: os.userInfo().username,
    build: await buildLabel(),
    feedbackStore: lazyFeedbackStore(DEFAULT_FEEDBACK_DIR),
  };
  const server = createObservatoryServer(ctx);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  // serve.json is 0600 in a 0700 folder that no bot mounts; it carries the
  // dashboard URL with its token so that `open board` can open it.
  fs.writeFileSync(
    SERVE_FILE,
    JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString(), swarmOpenUrl: swarm.openUrl }),
    { mode: 0o600 },
  );
  console.log(`observatory: http://127.0.0.1:${port}/   (bookmark this address; \`make observe-open\` unlocks a new browser; Ctrl-C stops it)`);
  console.log(`colony: read from ${swarm.root} with ${swarmPython()} (no dashboard needed)`);
  console.log(
    swarm.managed
      ? `swarm dashboard: ${swarm.url} (started with the observatory; link on the Work page, or \`make swarm-open\`)`
      : `swarm dashboard: ${swarm.note}`,
  );
  console.log(`feedback: ${DEFAULT_FEEDBACK_DIR} (\`make feedback\` lists requests, \`make feedback-pull\` queues them)`);
  const proxy = await proxyState();
  console.log(
    proxy === "running"
      ? "port proxy: running"
      : `port proxy: ${proxy} — the sandboxed bots' Control UIs need it: \`cd bots && make observatory-proxy-up\``,
  );
  if (flags.open) {
    openInBrowser(`http://127.0.0.1:${port}/#t=${token}`);
  }
  // Read every running bot's face now, so the page has it on first load.
  ctx.discover().then(
    (f) => f.bots.forEach((b) => maybeRefreshIdentity(ctx, b)),
    () => {},
  );
  const stop = () => {
    try {
      const info = JSON.parse(fs.readFileSync(SERVE_FILE, "utf8"));
      if (info.pid === process.pid) fs.rmSync(SERVE_FILE);
    } catch {
      // already gone
    }
    if (dashboard?.state === "managed") dashboard.stop();
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function feedbackLine(f) {
  const first = f.body.split("\n")[0].slice(0, 70);
  const images = f.attachments.length ? ` [${f.attachments.length} img]` : "";
  return `${f.ref}  ${pad(f.status, 11)} ${pad((f.submittedAt ?? f.createdAt ?? "").slice(0, 16), 17)} ${first}${images}`;
}

async function cmdFeedback(flags) {
  const [action = "list", ref, status] = flags._;
  const { openFeedbackStore, pullFeedback } = await import(FEEDBACK_MODULE.href);
  const store = openFeedbackStore(DEFAULT_FEEDBACK_DIR);
  try {
    switch (action) {
      case "list": {
        const items = store.list({ status: flags.status, limit: flags.limit ?? 50 });
        if (flags.json) {
          console.log(JSON.stringify(items, null, 2));
        } else if (!items.length) {
          console.log(`no requests${flags.status ? ` with status ${flags.status}` : ""}`);
        } else {
          items.forEach((f) => console.log(feedbackLine(f)));
        }
        return;
      }
      case "show": {
        if (!ref) throw new Error("feedback show needs a reference (FB-XXXXXXXX)");
        const f = store.get(ref);
        if (flags.json) {
          console.log(JSON.stringify(f, null, 2));
          return;
        }
        console.log(`${f.ref}  ${f.status}  by ${f.author ?? "?"}  submitted ${f.submittedAt ?? "—"}  updated ${f.updatedAt}`);
        console.log(`\n${f.body}\n`);
        for (const a of f.attachments) console.log(`image ${a.seq}: ${a.path}  (${a.name}, ${a.bytes} bytes${a.stored ? "" : ", NOT stored"})`);
        console.log(`context: ${JSON.stringify(f.context)}`);
        if (f.resolution) console.log(`resolution: ${f.resolution}`);
        return;
      }
      case "pull": {
        const out = flags.out ?? DEFAULT_PULL_DIR;
        const results = pullFeedback(store, out, { dryRun: flags.dryRun });
        if (!results.length) console.log("no new requests");
        for (const r of results) {
          console.log(r.action === "would pull" ? `would pull ${r.ref}: ${r.first}` : `${r.ref}: ${r.action}  ${r.file}${r.note ? `  (${r.note})` : ""}`);
        }
        if (results.some((r) => r.action === "left alone")) process.exitCode = 1;
        return;
      }
      case "set": {
        if (!ref || !status) throw new Error("feedback set needs a reference and a status");
        const f = store.setStatus(ref, status, flags.note);
        console.log(`${f.ref} is now ${f.status}${f.resolution ? ` — ${f.resolution}` : ""}`);
        return;
      }
      case "withdraw": {
        if (!ref) throw new Error("feedback withdraw needs a reference");
        store.withdraw(ref);
        console.log(`${ref.toUpperCase()} withdrawn; its images are deleted`);
        return;
      }
      default:
        throw new Error(`unknown feedback action "${action}" (list, show, pull, set, withdraw)`);
    }
  } finally {
    store.close();
  }
}

export function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--open") flags.open = true;
    else if (a === "--no-commit") flags.noCommit = true;
    else if (a === "--port") flags.port = Number.parseInt(argv[++i], 10);
    else if (a === "--dir") flags.dir = argv[++i];
    else if (a === "--approve") flags.approve = argv[++i];
    else if (a === "--status") flags.status = argv[++i];
    else if (a === "--limit") flags.limit = Number.parseInt(argv[++i], 10);
    else if (a === "--out") flags.out = argv[++i];
    else if (a === "--note") flags.note = argv[++i];
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--no-dashboard") flags.noDashboard = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else flags._.push(a);
  }
  if (flags.port !== undefined && !(flags.port > 0 && flags.port < 65536)) {
    throw new Error("--port needs a number from 1 to 65535");
  }
  return flags;
}

const USAGE = `usage: claw-observatory.mjs <command>

  list [--json]                     every bot: state, Control UI address, .swarm board
  open <bot>|observatory|board      open an address in the default browser
  serve [--port N] [--open] [--dir PATH] [--no-dashboard]
                                    serve the observatory on 127.0.0.1 (default ${DEFAULT_PORT}),
                                    and start the swarm dashboard on ${SWARM_PORT}
  snapshot [--dir PATH] [--no-commit]
                                    copy each running bot's identity, memory and dream
                                    files into the history repository and commit
  pair <bot> [--approve REQUEST_ID] list, or approve, pending Control UI device pairings
  proxy-key                         create the port proxy access key if missing; print its path
  proxy-routes [--out FILE]         the port proxy's routes as a compose override, from the fleet
  key                               print the observatory access key (for a browser's unlock box)
  rotate-key                        replace the observatory access key
  feedback list [--status S[,S]] [--limit N] [--json]
                                    change requests from the page (default: all but drafts)
  feedback show <FB-ref> [--json]   one request, with the paths of its images
  feedback pull [--out DIR] [--dry-run]
                                    new requests -> .swarm/feedback/<ref>.md, status queued
  feedback set <FB-ref> <status> [--note TEXT]
                                    status: new, queued, in_progress, done, declined
  feedback withdraw <FB-ref>        delete a request that is still new
`;

async function main(argv) {
  const [command = "list", ...rest] = argv;
  const flags = parseFlags(rest);
  switch (command) {
    case "list":
      return cmdList(flags);
    case "open":
      if (!flags._[0]) throw new Error("open needs a bot key, `observatory`, or `board`");
      return cmdOpen(flags._[0]);
    case "serve":
      return cmdServe(flags);
    case "snapshot": {
      const result = await runSnapshot({ dir: flags.dir ?? DEFAULT_SNAPSHOT_DIR, commit: !flags.noCommit });
      if (result.failures > 0) process.exitCode = 1;
      return undefined;
    }
    case "pair":
      if (!flags._[0]) throw new Error("pair needs a bot key");
      return cmdPair(flags._[0], flags);
    case "feedback":
      return cmdFeedback(flags);
    case "proxy-routes": {
      const plan = planProxyRoutes((await discoverFleet()).bots);
      const text = renderProxyRoutesOverride(plan);
      if (flags.out) {
        fs.mkdirSync(path.dirname(flags.out), { recursive: true });
        fs.writeFileSync(flags.out, text);
        console.log(`${plan.routes.length} proxy routes → ${flags.out}${plan.skipped.length ? ` (no route: ${plan.skipped.map((s) => s.key).join(", ")})` : ""}`);
      } else {
        process.stdout.write(text);
      }
      return undefined;
    }
    case "key":
      // For a browser that `open` cannot reach, such as a Safari web app:
      // paste the key into the page's unlock box.
      process.stdout.write(`${ensureKey(OBSERVATORY_KEY_FILE)}\n`);
      return undefined;
    case "rotate-key":
      rotateKey(OBSERVATORY_KEY_FILE);
      console.log(`new observatory key in ${OBSERVATORY_KEY_FILE}; every browser must unlock again (make observe-open), and a running server must restart`);
      return undefined;
    case "proxy-key":
      ensureProxyKey();
      console.log(PROXY_KEY_FILE);
      return undefined;
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(USAGE);
      return undefined;
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

// Compare real paths, not import.meta.url with a `file://` template: the
// launchd copy lives under "Application Support", and import.meta.url encodes
// that space as %20 (and resolves symlinks, which argv[1] does not). The
// template never matched there, so the nightly job exited 0 without running
// (2026-09-15 to 2026-09-22: seven snapshots lost).
function isMainModule() {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`claw-observatory: ${err.message}\n`);
    process.exit(2);
  });
}
