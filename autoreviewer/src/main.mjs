// The autoreviewer bot (CLAW-119): entry point. Design: .swarm/PEER_GRANTS.md.
//
// Environment:
//   AUTOREVIEWER_TELEGRAM_TOKEN_FILE  file holding the bot token (BotFather). Never an env value.
//   AUTOREVIEWER_OWNER_ID             Mike's Telegram user ID
//   AUTOREVIEWER_CHAT_ID              the autoreviewer chat (default: the owner ID, i.e. the DM)
//   AUTOREVIEWER_LEDGER_DIR           grant ledger directory (default /approvals/peer-grants)
//   AUTOREVIEWER_CLIENT_MAP           source address -> bot map (scripts/claw-autoreviewer-map)
//   AUTOREVIEWER_BOTS                 comma list of fleet bot names a grant may name
//   AUTOREVIEWER_MAIL_ROUTES          scripts/claw-mail-routes.json; a grant needs a relay route requester -> grantee
//   AUTOREVIEWER_TTL_BUTTONS          default "1,4,24"
//   AUTOREVIEWER_LISTEN               default 0.0.0.0:8791
//   HTTPS_PROXY                       the fleet egress proxy, the only route to api.telegram.org

import { readFileSync } from "node:fs";
import { AutoreviewerBot } from "./bot.mjs";
import { createApi } from "./api.mjs";
import { ClientMap } from "./clientmap.mjs";
import { GrantLedger } from "./ledger.mjs";
import { TelegramClient } from "./telegram.mjs";

const env = process.env;
const log = (row) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");

function required(name) {
  const v = (env[name] ?? "").trim();
  if (!v) {
    log({ event: "config_error", missing: name });
    process.exit(2);
  }
  return v;
}

const token = readFileSync(required("AUTOREVIEWER_TELEGRAM_TOKEN_FILE"), "utf8").trim();
const ownerId = Number(required("AUTOREVIEWER_OWNER_ID"));
const chatId = Number(env.AUTOREVIEWER_CHAT_ID || ownerId);
const bots = required("AUTOREVIEWER_BOTS").split(",").map((s) => s.trim()).filter(Boolean);
const ttlButtons = (env.AUTOREVIEWER_TTL_BUTTONS || "1,4,24").split(",").map(Number).filter((n) => n > 0 && n <= 24);
const [host, port] = (env.AUTOREVIEWER_LISTEN || "0.0.0.0:8791").split(":");

// Read on every proposal, so a route change needs no restart. A missing or
// unreadable routes file allows no pair at all.
const routesFile = required("AUTOREVIEWER_MAIL_ROUTES");
const canMail = (from, to) => {
  try {
    const routes = JSON.parse(readFileSync(routesFile, "utf8")).routes ?? [];
    return routes.some((r) => r.from === from && r.to === to);
  } catch {
    return false;
  }
};

const ledger = new GrantLedger(env.AUTOREVIEWER_LEDGER_DIR || "/approvals/peer-grants", { bots, canMail });
const clientMap = new ClientMap(required("AUTOREVIEWER_CLIENT_MAP"));
const telegram = new TelegramClient({ token, proxy: env.HTTPS_PROXY || env.https_proxy });
const bot = new AutoreviewerBot({ telegram, ledger, ownerId, chatId, ttlButtons, log });
ledger.onSweep = (changed) => bot.onSwept(changed);

createApi({ ledger, clientMap, bot, log }).listen(Number(port), host, () =>
  log({ event: "listening", host, port: Number(port), bots, ttlButtons }),
);

setInterval(() => ledger.sweep(), 30_000).unref();

try {
  await telegram.setMyCommands(bot.commands.menu());
} catch (err) {
  log({ event: "set_commands_failed", error: String(err.message ?? err) });
}

let backoffMs = 1000;
for (;;) {
  try {
    await bot.pollOnce(50);
    backoffMs = 1000;
  } catch (err) {
    log({ event: "poll_failed", error: String(err.message ?? err), retry_ms: backoffMs });
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 2, 60_000);
  }
}
