/**
 * operating-system-sandbox — gitignore read-shroud (CLAW-043).
 *
 * Intercepts Read/Bash tool RESULTS before the model reasons on them and
 * withholds the contents of gitignored / secret-shaped files, leaving metadata
 * (exists/size/mode/mtime) visible. This is the app-layer half of Mike's rule
 * ("a bot can edit a gitignored file but cannot see it unless per-session
 * unlocked"); the OS sandbox (internal:true + egress-proxy) is the hard half
 * that makes anything read here non-exfiltratable regardless.
 *
 * SEAM: api.registerAgentToolResultMiddleware runs *before the model sees the
 * result* and exposes the tool args (the path we classify on). openclaw gates
 * this seam to origin:"bundled" plugins — so this extension must be baked into
 * openclaw's dist/extensions at image-build time (see Dockerfile.runtime) and
 * declare contracts.agentToolResultMiddleware. If loaded as a plain --link
 * extension the registration silently no-ops; we log loudly at boot so that
 * failure mode is never silent.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  classifyPath,
  discoverIgnored,
  type ExecFn,
} from "./src/shroud-policy.js";
import {
  applyPlaceholder,
  extractPathTokens,
  extractReadPath,
  shroudPlaceholder,
  type ShroudStat,
} from "./src/shroud-transform.js";

interface ShroudConfig {
  reachRoots: string[];
  enforce: boolean;
  auditPath?: string;
  rescanIntervalMs: number;
}

const execFn: ExecFn = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

function safeStat(abs: string): ShroudStat | undefined {
  try {
    const s = fs.statSync(abs);
    return {
      size: s.size,
      mode: "0" + (s.mode & 0o777).toString(8),
      mtimeIso: new Date(s.mtimeMs).toISOString(),
    };
  } catch {
    return undefined;
  }
}

export default {
  id: "operating-system-sandbox",
  name: "OS Sandbox — gitignore read-shroud",
  description:
    "Withholds contents of gitignored/secret files from Read/Bash results before the model sees them; metadata still passes. Pairs with the egress sandbox.",

  register(api: any) {
    const raw = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const cfg: ShroudConfig = {
      reachRoots: Array.isArray(raw.reachRoots) ? (raw.reachRoots as string[]) : [],
      enforce: raw.enforce !== false, // default true; set false for audit-only dry-run
      auditPath:
        (raw.auditPath as string) ??
        path.join(api.runtime?.stateDir ?? "/home/node/.openclaw", "logs", "shroud-audit.jsonl"),
      rescanIntervalMs: typeof raw.rescanIntervalMs === "number" ? raw.rescanIntervalMs : 60_000,
    };

    const log = api.logger ?? console;

    // --- gitignore manifest with a small TTL cache (Layer 1) ---
    let manifest = new Set<string>();
    let builtAt = 0;
    const manifestNow = (): ReadonlySet<string> => {
      const age = Date.now() - builtAt;
      if (age > cfg.rescanIntervalMs || builtAt === 0) {
        try {
          manifest = discoverIgnored(cfg.reachRoots, execFn);
          builtAt = Date.now();
        } catch (e) {
          log.warn?.(`[os-sandbox] gitignore scan failed: ${String(e)}`);
        }
      }
      return manifest;
    };

    // CLAW-044: per-session unlock set. Stub returns empty until the unlock
    // flow (approval-gate → Telegram → session unlock-list) lands.
    const unlockedFor = (_sessionId?: string): ReadonlySet<string> => new Set<string>();

    const audit = (rec: Record<string, unknown>) => {
      try {
        fs.mkdirSync(path.dirname(cfg.auditPath!), { recursive: true });
        fs.appendFileSync(cfg.auditPath!, JSON.stringify(rec) + "\n");
      } catch {
        /* audit is best-effort; never block the tool path on it */
      }
    };

    const shroudVerdict = (abs: string, sessionId?: string) =>
      classifyPath(abs, { ignored: manifestNow(), unlocked: unlockedFor(sessionId) });

    const handler = (event: any, ctx: any) => {
      const tool = String(event?.toolName ?? "").toLowerCase();

      if (tool === "read") {
        const p = extractReadPath(event.args);
        if (!p) return;
        const abs = path.resolve(p);
        const v = shroudVerdict(abs, ctx?.sessionId);
        if (!v.shroud) return; // passthrough
        audit({
          ts: new Date().toISOString(),
          sessionId: ctx?.sessionId,
          tool,
          path: abs,
          reason: v.reason,
          action: cfg.enforce ? "shrouded" : "audit-only",
        });
        if (!cfg.enforce) return; // dry-run: record but let contents through
        const ph = shroudPlaceholder(abs, v.reason, safeStat(abs));
        return { result: applyPlaceholder(event.result, ph) };
      }

      if (tool === "bash") {
        const cmd = String(event?.args?.command ?? "");
        const base = typeof event?.cwd === "string" ? event.cwd : "/";
        for (const tok of extractPathTokens(cmd)) {
          const abs = path.isAbsolute(tok) ? path.resolve(tok) : path.resolve(base, tok);
          const v = shroudVerdict(abs, ctx?.sessionId);
          if (v.shroud) {
            audit({
              ts: new Date().toISOString(),
              sessionId: ctx?.sessionId,
              tool,
              path: abs,
              reason: v.reason,
              action: cfg.enforce ? "shrouded-bash" : "audit-only",
            });
            if (!cfg.enforce) return;
            const ph =
              `«shrouded: bash output withheld — the command referenced a shrouded path ` +
              `(${abs}, ${v.reason}). Request a per-session unlock to run reads against it.»`;
            return { result: applyPlaceholder(event.result, ph) };
          }
        }
        return;
      }

      return;
    };

    try {
      if (typeof api.registerAgentToolResultMiddleware === "function") {
        // Cover BOTH agent runtimes — pi (gateway/Telegram) AND codex (the
        // `openclaw agent --local` embedded path). The shroud must apply
        // regardless of how a tool call is driven; pi-only left the CLI path
        // unshrouded (verified 2026-07-13 — a --local read wrote no audit).
        api.registerAgentToolResultMiddleware(handler, { runtimes: ["pi", "codex"] });
        log.info?.(
          `[os-sandbox] read-shroud active (enforce=${cfg.enforce}, roots=${cfg.reachRoots.length}, ` +
            `source=${api.source ?? "?"}). If source!=bundled this seam no-ops — verify a shroud fires.`,
        );
      } else {
        log.error?.("[os-sandbox] registerAgentToolResultMiddleware unavailable — shroud INERT");
      }
    } catch (e) {
      log.error?.(`[os-sandbox] failed to register read-shroud: ${String(e)}`);
    }
  },
};
