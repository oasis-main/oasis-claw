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
//   AUTOREVIEWER_GH_DIR               GitHub access requests folder (CLAW-121; unset = feature off)
//   AUTOREVIEWER_GH_ACCOUNTS          GitHub accounts with a minter App, comma list
//   AUTOREVIEWER_GH_REQUESTERS        bots that may request GitHub access, comma list
//   AUTOREVIEWER_STATE_DIR            writable state (watches.json); default /var/lib/autoreviewer
//   AUTOREVIEWER_SNAPSHOT             fleet snapshot (scripts/claw-fleet-snapshot.mjs), read-only
//   HTTPS_PROXY                       the fleet egress proxy, the only route to api.telegram.org

import { readFileSync } from "node:fs";
import { AutoreviewerBot } from "./bot.mjs";
import { createApi } from "./api.mjs";
import { ClientMap } from "./clientmap.mjs";
import { GithubGrantStore } from "./ghgrants.mjs";
import { registerMonitorCommands } from "./monitor.mjs";
import { registerWatchCommands, Watcher } from "./watch.mjs";
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
const list = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const ghStore = env.AUTOREVIEWER_GH_DIR && list(env.AUTOREVIEWER_GH_ACCOUNTS).length
  ? new GithubGrantStore(env.AUTOREVIEWER_GH_DIR, {
      bots,
      accounts: list(env.AUTOREVIEWER_GH_ACCOUNTS),
      requesters: list(env.AUTOREVIEWER_GH_REQUESTERS),
    })
  : null;
const bot = new AutoreviewerBot({ telegram, ledger, ghStore, ownerId, chatId, ttlButtons, log });
ledger.onSweep = (changed) => bot.onSwept(changed);
// CLAW-122: fleet monitoring commands over the Mac's sanitized snapshot.
const snapshotPath = env.AUTOREVIEWER_SNAPSHOT || "/run/fleet-snapshot/snapshot.json";
registerMonitorCommands(bot.commands, snapshotPath);
// CLAW-122 slice 3: /watch alerts, checked every minute against the snapshot.
const watcher = new Watcher({
  stateFile: `${env.AUTOREVIEWER_STATE_DIR || "/var/lib/autoreviewer"}/watches.json`,
  snapshotPath,
  notify: (text) => telegram.sendMessage(chatId, text),
});
registerWatchCommands(bot.commands, watcher, bots);
setInterval(() => {
  watcher.tick().catch((err) => log({ event: "watch_tick_failed", error: String(err.message ?? err) }));
}, 60_000).unref();

createApi({ ledger, clientMap, bot, ghStore, log }).listen(Number(port), host, () =>
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
