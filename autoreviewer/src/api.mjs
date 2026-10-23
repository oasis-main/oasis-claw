// The autoreviewer bot's fleet-facing HTTP interface (CLAW-119).
//
// Bots may PROPOSE a grant and READ grants. No route decides, activates or
// revokes a grant: only Mike's button press in Telegram (bot.mjs) does that.
// The requester is the bot that the caller's source address maps to
// (clientmap.mjs); a "requester" field in the body is ignored. An unmapped
// address gets 403 on every route except /healthz.
//
//   GET  /healthz
//   POST /v1/grants              body: grantees, thread_id, topic, intent, ttl_hours,
//                                      [families], [path_prefixes], [max_actions]
//   GET  /v1/grants[?status=active]
//   GET  /v1/grants/<id>[?wait_ms=N]   long-poll while the grant is still proposed
//   POST /v1/directives          body: bot, goal, [may], [must_not], [lane], [ttl_hours<=168]
//                                (CLAW-124; a bot for itself, a coordinator for any bot)
//   POST /v1/github-grants       body: bot, account, repos[], access ("read"|"write"), reason
//   GET  /v1/github-grants/<id>[?wait_ms=N]   (CLAW-121; requesters are configured)

import { createServer } from "node:http";
import { GrantError } from "./ledger.mjs";

const BODY_MAX = 16 * 1024;
const WAIT_MAX_MS = 10 * 60 * 1000;
const WAIT_STEP_MS = 500;

function publicGrant(g) {
  const { card, ...rest } = g;
  return rest;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_MAX) {
        reject(new GrantError("body too large", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new GrantError("body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * @param {object} o
 * @param {import("./ledger.mjs").GrantLedger} o.ledger
 * @param {import("./clientmap.mjs").ClientMap} o.clientMap
 * @param {import("./bot.mjs").AutoreviewerBot} o.bot
 * @param {(row: object) => void} [o.log]
 */
export function createApi({ ledger, clientMap, bot, ghStore = null, coordinators = [], log = () => {} }) {
  return createServer(async (req, res) => {
    const send = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url ?? "/", "http://autoreviewer");
      if (req.method === "GET" && url.pathname === "/healthz") return send(200, { ok: true });

      const caller = clientMap.botFor(req.socket.remoteAddress);
      // "mike" and "console" (CLAW-127) are never network callers, whatever the map says.
      if (!caller || caller === "mike" || caller === "console") {
        log({ event: "refused_unmapped", address: req.socket.remoteAddress, path: url.pathname });
        return send(403, { error: "caller address is not a mapped fleet bot" });
      }

      if (req.method === "POST" && url.pathname === "/v1/grants") {
        const body = await readBody(req);
        const { grant, duplicate } = ledger.propose(caller, body);
        log({ event: duplicate ? "proposal_duplicate" : "proposed", id: grant.id, requester: caller });
        if (!duplicate) {
          try {
            await bot.sendGrantCard(grant);
          } catch (err) {
            // No card means Mike cannot answer; close the proposal at once.
            ledger.revoke(grant.id, "the card could not be sent to Mike", "autoreviewer");
            log({ event: "card_send_failed", id: grant.id, error: String(err.message ?? err) });
            return send(502, { error: "the card could not be sent to Mike", grant: publicGrant(grant) });
          }
        }
        return send(duplicate ? 200 : 201, { grant: publicGrant(grant), duplicate });
      }

      if (req.method === "GET" && url.pathname === "/v1/grants") {
        ledger.sweep();
        const status = url.searchParams.get("status");
        return send(200, { grants: ledger.list(status ? { statuses: [status] } : {}).map(publicGrant) });
      }

      if (req.method === "POST" && url.pathname === "/v1/directives") {
        const body = await readBody(req);
        const d = ledger.proposeDirective(caller, body, { coordinators });
        log({ event: "directive_proposed", id: d.id, proposer: caller, bot: d.grantees[0] });
        try {
          await bot.sendDirectiveCard(d);
        } catch (err) {
          ledger.revoke(d.id, "the card could not be sent to Mike", "autoreviewer");
          return send(502, { error: "the card could not be sent to Mike" });
        }
        return send(201, { directive: publicGrant(d) });
      }

      if (url.pathname.startsWith("/v1/github-grants")) {
        if (!ghStore) return send(404, { error: "GitHub requests are not configured" });
        if (req.method === "POST" && url.pathname === "/v1/github-grants") {
          const body = await readBody(req);
          const { request, duplicate } = ghStore.propose(caller, body);
          log({ event: duplicate ? "github_duplicate" : "github_proposed", id: request.id, requester: caller, bot: request.bot });
          if (!duplicate) {
            try {
              await bot.sendGhCard(request);
            } catch (err) {
              ghStore.revoke(request.id, "autoreviewer");
              log({ event: "card_send_failed", id: request.id, error: String(err.message ?? err) });
              return send(502, { error: "the card could not be sent to Mike" });
            }
          }
          const { card, ...pub } = request;
          return send(duplicate ? 200 : 201, { request: pub, duplicate });
        }
        const gm = /^\/v1\/github-grants\/(GH-\d{4,})$/.exec(url.pathname);
        if (req.method === "GET" && gm) {
          const waitMs = Math.min(Math.max(Number(url.searchParams.get("wait_ms") ?? 0) || 0, 0), WAIT_MAX_MS);
          const started = Date.now();
          let r = ghStore.get(gm[1]);
          if (!r) return send(404, { error: `no request ${gm[1]}` });
          while (r.status === "proposed" && Date.now() - started < waitMs && !res.destroyed) {
            await new Promise((ok) => setTimeout(ok, WAIT_STEP_MS));
            r = ghStore.get(gm[1]);
          }
          const { card, ...pub } = r;
          return send(200, { request: pub, minter: ghStore.minterStatus()[r.id] ?? null });
        }
        return send(404, { error: "no such route" });
      }

      const m = /^\/v1\/grants\/(GRANT-\d{4,})$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const waitMs = Math.min(Math.max(Number(url.searchParams.get("wait_ms") ?? 0) || 0, 0), WAIT_MAX_MS);
        const started = Date.now();
        let g = ledger.get(m[1]);
        if (!g) return send(404, { error: `no grant ${m[1]}` });
        while (g.status === "proposed" && Date.now() - started < waitMs && !res.destroyed) {
          await new Promise((r) => setTimeout(r, WAIT_STEP_MS));
          ledger.sweep();
          g = ledger.get(m[1]);
        }
        return send(200, { grant: publicGrant(g) });
      }

      return send(404, { error: "no such route" });
    } catch (err) {
      const status = err instanceof GrantError ? err.status : 500;
      if (status === 500) log({ event: "api_error", error: String(err.message ?? err) });
      return send(status, { error: String(err.message ?? err) });
    }
  });
}
