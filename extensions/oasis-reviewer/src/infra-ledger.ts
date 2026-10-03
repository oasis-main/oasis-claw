import { readFileSync, statSync } from "node:fs";
import { isAbsolute, normalize, resolve as resolvePath } from "node:path";

// ── Infrastructure approval ledger (CLAW-116, 2026-09-16) ─────────────────────
// Mike: Yes Man controls the infrastructure, and other bots may request changes
// from him "so long as it's genuinely aligned with the existing approval
// history". This module is the deterministic half of that sentence.
//
// The ledger is a JSON file Mike writes on the host with scripts/claw-approvals.
// It is mounted READ-ONLY into the applying bot and no bot can write it, so a
// bot cannot approve its own work and a peer cannot approve it by mail. Each
// ACTIVE entry names a directory and the command shapes Mike has approved
// there. An infrastructure-changing command (per-bot `infraGateExtra`) runs
// only if an active, unexpired entry covers it; otherwise it escalates under a
// principle that is never auto-downgraded, so an unattended (mail-woken) run
// fails closed and an attended run asks Mike.
//
// Matching is deliberately conservative:
//   - the command must be ONE simple command, optionally preceded by a single
//     `cd <dir> &&`. Any other shell operator, substitution, or redirect means
//     "no match". A compound command could otherwise hide an unapproved step
//     behind an approved one.
//   - the directory is resolved from the exec `workdir`, that leading `cd`, and
//     a terraform `-chdir=`, in that order, and must sit under one of the
//     entry's dir_prefixes.
//   - patterns are anchored by the author; the ledger CLI anchors them with `^`.

export interface LedgerEntry {
  id: string;
  status: "active" | "proposed" | "revoked";
  title?: string;
  dir_prefixes: string[];
  command_patterns: string[];
  requesters?: string[];
  limits?: string[];
  expires?: string | null;
  approved_at?: string | null;
  source?: string;
}

export interface LoadedLedger {
  entries: LedgerEntry[];
  error?: string;
}

let cache: { path: string; mtimeMs: number; size: number; value: LoadedLedger } | undefined;

/** Read the ledger fresh whenever the file changes, so a new approval needs no restart. */
export function loadLedger(path: string): LoadedLedger {
  let st;
  try {
    st = statSync(path);
  } catch {
    return { entries: [], error: `approval ledger not found at ${path}` };
  }
  if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    return cache.value;
  }
  let value: LoadedLedger;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries?: unknown };
    const entries = Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : [];
    value = { entries };
  } catch (e) {
    value = { entries: [], error: `approval ledger unreadable: ${(e as Error).message}` };
  }
  cache = { path, mtimeMs: st.mtimeMs, size: st.size, value };
  return value;
}

function isEntry(v: unknown): v is LedgerEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.status === "string" &&
    Array.isArray(e.dir_prefixes) &&
    e.dir_prefixes.every((p) => typeof p === "string" && isAbsolute(p)) &&
    Array.isArray(e.command_patterns) &&
    e.command_patterns.every((p) => typeof p === "string")
  );
}

// Anything that lets one exec string do more than one thing, or feed one
// command's output into another. `$` also covers variable expansion, which
// could change a directory or argument after the ledger check.
const SHELL_META = /[;&|`$<>()\\\n\r]/;
const LEADING_CD = /^cd\s+(\S+)\s*&&\s*([\s\S]*)$/;
const CHDIR = /(?:^|\s)-chdir=(?:"([^"]+)"|'([^']+)'|(\S+))/;

function unquote(s: string): string {
  return s.replace(/^(["'])(.*)\1$/, "$2");
}

export interface EffectiveCommand {
  dir: string | null;
  simple: string;
}

/** Reduce an exec string to one simple command plus the directory it acts on, or null. */
export function effectiveCommand(cmd: string, workdir?: string): EffectiveCommand | null {
  let rest = cmd.trim();
  let dir: string | null = workdir && isAbsolute(workdir) ? normalize(workdir) : null;
  const cd = LEADING_CD.exec(rest);
  if (cd) {
    const target = unquote(cd[1]);
    if (SHELL_META.test(target)) return null;
    if (!isAbsolute(target) && !dir) return null;
    dir = normalize(resolvePath(dir ?? "/", target));
    rest = cd[2].trim();
  }
  if (!rest || SHELL_META.test(rest) || /^cd\s/.test(rest)) return null;
  const chdir = CHDIR.exec(rest);
  if (chdir) {
    const target = chdir[1] ?? chdir[2] ?? chdir[3];
    if (!isAbsolute(target) && !dir) return null;
    dir = normalize(resolvePath(dir ?? "/", target));
  }
  return { dir, simple: rest.replace(/\s+/g, " ") };
}

// A dir prefix may use `*` for "any characters inside ONE path component", so an
// entry can name the pinned-commit checkout convention
// /work/apply/<repo>@<sha>/... as /work/apply/oasis-cloud-admin@*/... . A `*`
// never matches a slash, so it cannot widen the prefix to another tree.
function underDir(p: string, root: string): boolean {
  const r = normalize(root).replace(/\/+$/, "");
  if (!r.includes("*")) return p === r || p.startsWith(r + "/");
  const body = r
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${body}(?:/|$)`).test(p);
}

/** The first active, unexpired entry that covers this command, or null. */
export function matchLedger(
  cmd: string,
  workdir: string | undefined,
  entries: readonly LedgerEntry[],
  now: number = Date.now(),
): LedgerEntry | null {
  const eff = effectiveCommand(cmd, workdir);
  if (!eff || !eff.dir) return null;
  for (const e of entries) {
    if (e.status !== "active") continue;
    if (e.expires) {
      const t = Date.parse(e.expires);
      if (Number.isNaN(t) || t <= now) continue;
    }
    if (!e.dir_prefixes.some((p) => underDir(eff.dir as string, p))) continue;
    const hit = e.command_patterns.some((src) => {
      try {
        return new RegExp(src).test(eff.simple);
      } catch {
        return false;
      }
    });
    if (hit) return e;
  }
  return null;
}

export const INFRA_LEDGER_RETRY_HINT =
  "the ledger matches ONE simple command, for example `terraform apply -input=false <name>.tfplan`, with the approved directory as the exec workdir or as a leading `cd <dir> && `; a `VAR=value` prefix, `export`, a redirect such as `2>&1`, a pipe, or `;` never matches. If the change is already in that form, no active entry covers it: reply NEEDS MIKE to the requester and do not reshape the command";

/** One-paragraph summary of a matched entry, for the Layer 2 judge (trusted: host-written). */
export function describeLedgerEntry(e: LedgerEntry): string {
  const lines = [
    `${e.id}${e.title ? ` — ${e.title}` : ""}`,
    `directories: ${e.dir_prefixes.join(", ")}`,
    `command patterns: ${e.command_patterns.join(" | ")}`,
  ];
  if (e.requesters && e.requesters.length) lines.push(`requesters: ${e.requesters.join(", ")}`);
  for (const l of e.limits ?? []) lines.push(`limit: ${l}`);
  if (e.expires) lines.push(`expires: ${e.expires}`);
  return lines.join("\n");
}
