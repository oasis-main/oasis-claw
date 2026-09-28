#!/usr/bin/env node
// ── claw-port-proxy (CLAW-108) ───────────────────────────────────────────────
// Publishes a bot's gateway (Control UI page + WebSocket) on the Mac's
// loopback, for the bots Docker will not publish directly.
//
// WHY THIS EXISTS
//   A container attached ONLY to an `internal: true` network keeps its `ports:`
//   binding in config, but Docker never publishes it — no error, no warning.
//   House, Kolmogorov, Yes Man, ButterBolt and Van Helsing sit on
//   oasis_sandboxed alone, so `127.0.0.1:1879x` was dead for all five. This
//   process runs in one small container attached to oasis_sandboxed AND to a
//   dedicated non-internal network that exists only to carry published ports.
//   Each published port forwards to one bot's gateway.
//
// THE ACCESS KEY — WHY THE PROXY HAS ITS OWN LOCK
//   A published loopback port is not private to the Mac's user. Docker Desktop
//   forwards host.docker.internal to the Mac's loopback, and on this host it
//   also routes between bridge networks. Measured 2026-09-15: Nimbus (on
//   oasis_runtime) CONNECTED to host.docker.internal:18891 and to
//   172.29.186.2:18891. Unlocked, this proxy would give Nimbus and Hello World
//   a network path to five gateways they cannot otherwise reach, guarded only
//   by each gateway's own pre-auth code — the surface CLAW-030 (GHSA-chr9) was
//   about. So nothing is forwarded until the client presents the access key.
//   The key lives only on the Mac
//   (~/Library/Application Support/oasis-x/observatory/proxy-key, mounted
//   read-only here), outside every bot mount.
//   A browser presents the key as an HttpOnly, SameSite=Strict cookie, set once
//   by UNLOCK_PATH. The key arrives in the URL fragment (never sent to a
//   server), the unlock page removes it from the address bar, then POSTs it.
//   Cookies are scoped to the host, not the port: one unlock on 127.0.0.1
//   covers every proxy port.
//
// THE ONE HEADER IT CHANGES, AND WHY THAT IS SAFE
//   The gateway admits a browser only when its Origin is in
//   gateway.controlUi.allowedOrigins (origin-check.ts). The entrypoint seeds
//   that list with the CONTAINER port (http://127.0.0.1:18789), so a browser on
//   host port 18891 is refused. Changing the list per bot is a gateway restart
//   (config-reload-plan.ts: prefix "gateway" → kind "restart") plus a baked-in
//   entrypoint change. Instead, this proxy rewrites Origin in exactly one case:
//   the value equals this listener's own loopback origin
//   (http://127.0.0.1:<port> or http://localhost:<port>). That value becomes
//   the origin the gateway already allows. Every other Origin passes through
//   unchanged, and the gateway still refuses it. A browser cannot forge Origin,
//   so a page from any other site — or from another local server on another
//   port — is still refused. The effect equals one extra allowlist entry.
//
// WHAT IT DOES NOT DO
//   - It adds no X-Forwarded-For / Forwarded / X-Real-IP, and it strips any a
//     client sends. The gateway sees the proxy's own address, which is not
//     loopback, so every browser still goes through device pairing.
//   - It carries no gateway token, and it removes its own cookie before
//     forwarding. Each gateway still requires its own token.
//   - It binds only LISTEN_HOST. The compose file pins that to the container's
//     address on the publish network, so no bot on oasis_sandboxed gains a new
//     listener to connect to (measured: House → 172.30.0.6:18891 refused).
//
// ENV
//   ROUTES           comma list of <listenPort>=<targetHost>:<targetPort>
//   ACCESS_KEY_FILE  file holding the access key (required)
//   LISTEN_HOST      address to bind (default 0.0.0.0)
//   ORIGIN_TO        origin every target gateway allows (default http://127.0.0.1:18789)

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";

export const COOKIE_NAME = "claw_proxy_key";
export const UNLOCK_PATH = "/__claw-proxy/unlock";
const KEY_RE = /^[A-Za-z0-9_-]{32,256}$/;
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

// Forwarding headers are only meaningful from a proxy the gateway trusts. This
// one vouches for nothing, so a client-supplied value must not reach the
// gateway looking as if it had.
const STRIPPED_HEADERS = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
]);

const BASE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function parsePort(raw, what) {
  if (!/^\d{1,5}$/.test(raw)) {
    throw new Error(`invalid ${what} port: ${raw}`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new Error(`invalid ${what} port: ${raw}`);
  }
  return port;
}

export function parseRoutes(spec) {
  const routes = [];
  const seen = new Set();
  const parts = String(spec ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    const match = part.match(/^(\d+)=([^:=]+):(\d+)$/);
    if (!match) {
      throw new Error(`invalid route: ${part}`);
    }
    const listenPort = parsePort(match[1], "listen");
    if (!HOST_RE.test(match[2])) {
      throw new Error(`invalid target host: ${match[2]}`);
    }
    const targetPort = parsePort(match[3], "target");
    if (seen.has(listenPort)) {
      throw new Error(`duplicate listen port: ${listenPort}`);
    }
    seen.add(listenPort);
    routes.push({ listenPort, targetHost: match[2], targetPort });
  }
  if (routes.length === 0) {
    throw new Error("ROUTES is empty");
  }
  return routes;
}

export function parseOriginTo(raw) {
  const value = String(raw ?? "").trim();
  if (!ORIGIN_RE.test(value)) {
    throw new Error(`invalid ORIGIN_TO: ${raw}`);
  }
  return value;
}

export function readAccessKey(file) {
  if (!file) {
    throw new Error("ACCESS_KEY_FILE is required");
  }
  const key = fs.readFileSync(file, "utf8").trim();
  if (!KEY_RE.test(key)) {
    throw new Error(`${file} must hold 32 to 256 URL-safe characters`);
  }
  return key;
}

export function keyMatches(given, key) {
  if (typeof given !== "string" || !KEY_RE.test(given) || typeof key !== "string") {
    return false;
  }
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(key).digest();
  return crypto.timingSafeEqual(a, b);
}

/** The value of this proxy's cookie in raw request headers, or null. */
export function cookieKey(rawHeaders) {
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() !== "cookie") {
      continue;
    }
    for (const part of rawHeaders[i + 1].split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0 && part.slice(0, eq).trim() === COOKIE_NAME) {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return null;
}

const isOwnOrigin = (value, port) =>
  typeof value === "string" &&
  [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(value.trim().toLowerCase());

/** Copy raw header pairs for the gateway: drop forwarding headers and this
 *  proxy's cookie, and map only this listener's own loopback Origin to
 *  `originTo`. */
export function rewriteHeaders(rawHeaders, listenPort, originTo) {
  const out = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const lower = name.toLowerCase();
    if (STRIPPED_HEADERS.has(lower)) {
      continue;
    }
    let value = rawHeaders[i + 1];
    if (lower === "origin" && isOwnOrigin(value, listenPort)) {
      value = originTo;
    }
    if (lower === "cookie") {
      value = value
        .split(";")
        .filter((part) => part.split("=")[0].trim() !== COOKIE_NAME)
        .join(";")
        .trim();
      if (!value) {
        continue;
      }
    }
    out.push(name, value);
  }
  return out;
}

export function serializeRequestHead(req, rawHeaders) {
  let head = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    head += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
  }
  return `${head}\r\n`;
}

function unlockPage(nonce) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Unlocking the Control UI</title></head>
<body style="font:14px/1.5 -apple-system,system-ui,sans-serif;margin:40px">
<p id="msg">Unlocking this browser for the bot Control UI…</p>
<script nonce="${nonce}">
(function () {
  var msg = document.getElementById("msg");
  var m = location.hash.match(/(?:^#|&)k=([A-Za-z0-9_-]{32,256})/);
  history.replaceState(null, "", location.pathname);
  if (!m) {
    msg.textContent = "This address carries no key. Open the bot from the observatory, or run: make control-ui BOT=<bot>";
    return;
  }
  fetch(location.pathname, { method: "POST", headers: { "content-type": "text/plain" }, body: m[1], credentials: "same-origin" })
    .then(function (r) {
      if (r.ok) { location.replace("/"); } else { msg.textContent = "The proxy refused this key (HTTP " + r.status + ")."; }
    })
    .catch(function (e) { msg.textContent = "Unlock failed: " + e.message; });
})();
</script>
</body>
</html>
`;
}

/** Start one listener. Resolves with the server and the port it bound (which
 *  differs from `listenPort` only when a test passes 0). */
export function startRoute({
  listenHost = "0.0.0.0",
  listenPort,
  targetHost,
  targetPort,
  originTo,
  accessKey,
  log = () => {},
}) {
  if (!KEY_RE.test(String(accessKey ?? ""))) {
    return Promise.reject(new Error("startRoute needs a valid accessKey"));
  }
  let boundPort = listenPort;
  const target = `${targetHost}:${targetPort}`;

  // One log line per 10 s per listener is enough to show that something is
  // knocking without letting a client flood the log.
  let lastLockedLog = 0;
  const noteLocked = (req) => {
    const now = Date.now();
    if (now - lastLockedLog >= 10_000) {
      lastLockedLog = now;
      log({ event: "locked", listenPort: boundPort, remote: req.socket?.remoteAddress ?? null });
    }
  };

  const handleUnlock = (req, res) => {
    if (req.method === "GET") {
      const nonce = crypto.randomBytes(16).toString("base64");
      res.writeHead(200, {
        ...BASE_HEADERS,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      res.end(unlockPage(nonce));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, BASE_HEADERS);
      res.end();
      return;
    }
    if (!isOwnOrigin(req.headers.origin, boundPort)) {
      noteLocked(req);
      res.writeHead(403, BASE_HEADERS);
      res.end();
      return;
    }
    let body = "";
    let tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 512) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooLarge) {
        return;
      }
      if (!keyMatches(body.trim(), accessKey)) {
        log({ event: "unlock-refused", listenPort: boundPort, remote: req.socket?.remoteAddress ?? null });
        res.writeHead(403, BASE_HEADERS);
        res.end();
        return;
      }
      res.writeHead(204, {
        ...BASE_HEADERS,
        "set-cookie": `${COOKIE_NAME}=${accessKey}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}`,
      });
      res.end();
    });
  };

  const server = http.createServer((req, res) => {
    const pathOnly = String(req.url ?? "/").split("?")[0];
    if (pathOnly === UNLOCK_PATH) {
      handleUnlock(req, res);
      return;
    }
    if (!keyMatches(cookieKey(req.rawHeaders), accessKey)) {
      noteLocked(req);
      res.writeHead(403, { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" });
      res.end("claw-port-proxy: this browser is not unlocked.\nOpen the bot from the observatory (make observe), or run: make control-ui BOT=<bot>\n");
      return;
    }
    const upstream = http.request({
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: req.url,
      // An array is written verbatim: no Host is added, and the original
      // Host (the browser's 127.0.0.1:<port>) is kept.
      headers: rewriteHeaders(req.rawHeaders, boundPort, originTo),
      // One upstream connection per request: nothing pooled across routes,
      // nothing held open after the response.
      agent: false,
    });
    upstream.on("response", (up) => {
      res.writeHead(up.statusCode ?? 502, up.statusMessage, up.rawHeaders);
      up.pipe(res);
    });
    upstream.on("error", (err) => {
      log({ event: "upstream-error", listenPort: boundPort, target, error: err.code ?? err.message });
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`claw-port-proxy: ${target} unreachable\n`);
      } else {
        res.destroy();
      }
    });
    res.on("close", () => {
      if (!res.writableFinished) {
        upstream.destroy();
      }
    });
    req.pipe(upstream);
  });

  server.on("upgrade", (req, socket, head) => {
    if (!keyMatches(cookieKey(req.rawHeaders), accessKey)) {
      noteLocked(req);
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = net.connect({ host: targetHost, port: targetPort });
    const destroyBoth = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.once("connect", () => {
      socket.setNoDelay(true);
      upstream.setNoDelay(true);
      upstream.write(serializeRequestHead(req, rewriteHeaders(req.rawHeaders, boundPort, originTo)));
      if (head && head.length > 0) {
        upstream.write(head);
      }
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", (err) => {
      log({ event: "upgrade-error", listenPort: boundPort, target, error: err.code ?? err.message });
      destroyBoth();
    });
    socket.on("error", destroyBoth);
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    // http.Server sockets allow half-open connections, so a FIN from one side
    // closes nothing by itself. pipe() forwards the FIN; if the other side
    // never answers with its own, stop holding both sockets after a grace.
    const closeSoon = () => setTimeout(destroyBoth, 5000).unref();
    socket.once("end", closeSoon);
    upstream.once("end", closeSoon);
  });

  server.on("clientError", (_err, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } else {
      socket.destroy();
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      boundPort = server.address().port;
      server.off("error", reject);
      resolve({ server, port: boundPort });
    });
  });
}

async function main() {
  const routes = parseRoutes(process.env.ROUTES);
  const accessKey = readAccessKey(process.env.ACCESS_KEY_FILE);
  const listenHost = process.env.LISTEN_HOST || "0.0.0.0";
  const originTo = parseOriginTo(process.env.ORIGIN_TO || "http://127.0.0.1:18789");
  const log = (entry) => {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  };
  const servers = [];
  for (const route of routes) {
    const { server, port } = await startRoute({ ...route, listenHost, originTo, accessKey, log });
    servers.push(server);
    log({ event: "listening", listen: `${listenHost}:${port}`, target: `${route.targetHost}:${route.targetPort}` });
  }
  const stop = () => {
    for (const server of servers) {
      server.close();
    }
    // Upgraded sockets are not tracked by server.close(); do not wait on them.
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

// Compare real paths: a `file://` template fails for a path with a space
// (import.meta.url has %20) or behind a symlink (import.meta.url is resolved).
function isMainModule() {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    process.stderr.write(`claw-port-proxy: ${err.message}\n`);
    process.exit(2);
  });
}
