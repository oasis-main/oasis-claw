/**
 * Loopback gateway RPC via the openclaw CLI's generic `gateway call`.
 *
 * Why a subprocess instead of an in-process client: the gateway's RPC
 * transport is WebSocket with its own handshake; the CLI already implements
 * it correctly and is guaranteed present in the runtime image. Spawning
 * `openclaw gateway call <method> --params <json> --json --token <t>` gives
 * us every method in server-methods-list (sessions.compact, sessions.reset,
 * sessions.list, sessions.send, ...) with zero protocol drift.
 *
 * NOTE: the child_process import below is why the entrypoint installs this
 * plugin with --dangerously-force-unsafe-install — same false-positive shape
 * as the vendored browser plugin (Chromium launch) and secrets-vault.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type GatewayCaller = (method: string, params?: unknown) => Promise<unknown>;

const DEFAULT_TIMEOUT_MS = 60_000;

function readToken(tokenFile?: string): string {
  const file =
    tokenFile ?? path.join(process.env.HOME ?? os.homedir(), ".openclaw", ".gateway-token");
  return fs.readFileSync(file, "utf-8").trim();
}

export function createGatewayCaller(opts?: {
  tokenFile?: string;
  timeoutMs?: number;
}): GatewayCaller {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (method, params) =>
    new Promise((resolve, reject) => {
      let token: string;
      try {
        token = readToken(opts?.tokenFile);
      } catch (err) {
        reject(new Error(`sleep-cycle: cannot read gateway token: ${String(err)}`));
        return;
      }
      execFile(
        "openclaw",
        [
          "gateway",
          "call",
          method,
          "--params",
          JSON.stringify(params ?? {}),
          "--json",
          "--token",
          token,
        ],
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            reject(new Error(`sleep-cycle: gateway call ${method} failed: ${error.message}`));
            return;
          }
          const text = stdout.trim();
          if (!text) {
            resolve(undefined);
            return;
          }
          // The CLI may print human banner lines before the JSON payload;
          // parse from the first JSON-looking character.
          const start = text.search(/[[{]/);
          try {
            resolve(JSON.parse(start >= 0 ? text.slice(start) : text));
          } catch {
            resolve(text);
          }
        },
      );
    });
}
