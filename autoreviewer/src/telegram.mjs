// Minimal Telegram Bot API client (CLAW-119). No dependencies.
//
// The autoreviewer bot sits only on internal networks. Its one route out is
// the fleet egress proxy, whose base allowlist already holds
// api.telegram.org. Node's fetch does not read HTTPS_PROXY on the Node 22
// runtime image, so this file opens the CONNECT tunnel itself. The bot token
// appears only in the request path inside the TLS tunnel; it is never logged.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";

/**
 * POST a JSON body over HTTPS, optionally through an HTTP CONNECT proxy.
 * Resolves { status, body } and never logs the URL.
 */
export function postJson(urlString, payload, { proxy, timeoutMs = 30_000 } = {}) {
  const url = new URL(urlString);
  const body = JSON.stringify(payload ?? {});
  const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));

  const send = (createConnection) =>
    new Promise((resolve, reject) => {
      // Through the proxy the TLS layer is already up on the tunnel socket, so
      // plain http.request runs over it. Pass createConnection with NO agent
      // option: `agent: false` makes Node build a fresh Agent, which ignores
      // createConnection and resolves the host itself (EAI_AGAIN on the
      // internal network; found by the live smoke test, 2026-10-12).
      const viaTunnel = !!createConnection;
      const req = (!viaTunnel && url.protocol === "https:" ? httpsRequest : httpRequest)(
        {
          host: url.hostname,
          port,
          path: url.pathname + url.search,
          method: "POST",
          headers,
          timeout: timeoutMs,
          ...(viaTunnel ? { createConnection } : {}),
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error(`telegram request timed out after ${timeoutMs} ms`)));
      req.on("error", reject);
      req.end(body);
    });

  if (!proxy || url.protocol !== "https:") return send(null);

  const p = new URL(proxy);
  return new Promise((resolve, reject) => {
    const connectReq = httpRequest({
      host: p.hostname,
      port: Number(p.port || 3128),
      method: "CONNECT",
      path: `${url.hostname}:${port}`,
      headers: { Host: `${url.hostname}:${port}` },
      timeout: timeoutMs,
    });
    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT refused: HTTP ${res.statusCode}`));
        return;
      }
      const tls = tlsConnect({ socket, servername: url.hostname });
      send(() => tls).then(resolve, reject);
    });
    connectReq.on("timeout", () => connectReq.destroy(new Error("proxy CONNECT timed out")));
    connectReq.on("error", reject);
    connectReq.end();
  });
}

export class TelegramClient {
  /**
   * @param {object} o
   * @param {string} o.token
   * @param {string} [o.apiBase]  default https://api.telegram.org
   * @param {string} [o.proxy]    http://egress-proxy:3128
   */
  constructor({ token, apiBase = "https://api.telegram.org", proxy } = {}) {
    if (!token) throw new Error("telegram token missing");
    this.token = token;
    this.apiBase = apiBase.replace(/\/$/, "");
    this.proxy = proxy || undefined;
  }

  async call(method, params = {}, { timeoutMs = 30_000 } = {}) {
    const r = await postJson(`${this.apiBase}/bot${this.token}/${method}`, params, { proxy: this.proxy, timeoutMs });
    let o;
    try {
      o = JSON.parse(r.body);
    } catch {
      throw new Error(`telegram ${method}: HTTP ${r.status}, unparseable body`);
    }
    if (!o.ok) throw new Error(`telegram ${method}: ${String(o.description ?? `HTTP ${r.status}`).slice(0, 200)}`);
    return o.result;
  }

  getUpdates(offset, timeoutS = 50) {
    return this.call(
      "getUpdates",
      { offset, timeout: timeoutS, allowed_updates: ["message", "callback_query"] },
      { timeoutMs: (timeoutS + 15) * 1000 },
    );
  }

  // Plain text only: no parse_mode, so bot-written text cannot format the card.
  sendMessage(chatId, text, replyMarkup) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  editMessageText(chatId, messageId, text, replyMarkup) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      link_preview_options: { is_disabled: true },
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    });
  }

  answerCallbackQuery(id, text) {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  }

  setMyCommands(commands) {
    return this.call("setMyCommands", { commands });
  }
}
