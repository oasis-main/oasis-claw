// Source address → bot name (CLAW-119). The autoreviewer bot names a caller
// from its source address, never from the request body, the same way the
// egress proxy partitions egress (CLAW-050). The bots run with cap_drop ALL on
// Docker bridge networks, so a bot cannot send from a peer's address.
//
// The map file is host-written by scripts/claw-autoreviewer-map from the live
// container addresses, and re-read whenever its mtime changes, so a bot
// recreate needs only a re-run of that script. Format, one per line:
//   172.30.10.12=alpha
// An address that is not in the map is refused.

import { existsSync, readFileSync, statSync } from "node:fs";

export function parseClientMap(text) {
  const out = new Map();
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [ip, bot] = line.split("=", 2).map((s) => s.trim());
    if (ip && bot) out.set(ip, bot);
  }
  return out;
}

/** Docker reports IPv4 callers as ::ffff:a.b.c.d on a dual-stack socket. */
export function normalizeAddress(addr) {
  const a = String(addr ?? "");
  return a.startsWith("::ffff:") ? a.slice(7) : a;
}

export class ClientMap {
  constructor(file) {
    this.file = file;
    this.mtimeMs = -1;
    this.map = new Map();
  }

  refresh() {
    if (!existsSync(this.file)) {
      this.map = new Map();
      this.mtimeMs = -1;
      return;
    }
    const m = statSync(this.file).mtimeMs;
    if (m === this.mtimeMs) return;
    this.map = parseClientMap(readFileSync(this.file, "utf8"));
    this.mtimeMs = m;
  }

  /** @returns {string|null} the bot name, or null when the address is unmapped. */
  botFor(remoteAddress) {
    this.refresh();
    return this.map.get(normalizeAddress(remoteAddress)) ?? null;
  }
}
