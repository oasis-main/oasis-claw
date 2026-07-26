/**
 * gitignore read-shroud — policy engine (CLAW-043, Layer 1 + classifier).
 *
 * PURE. No I/O except the injected `exec` used by `discoverIgnored`. This is the
 * seam-agnostic core: whichever openclaw seam ends up carrying the shroud
 * (bundled tool-result middleware vs. the tool_result_persist hook), it asks
 * this module one question — "is this absolute path shrouded right now?" — and
 * acts on the answer.
 *
 * Design: sandbox/GITIGNORE_SHROUD_DESIGN.md (Layers 1-2). The shroud hides
 * *contents*; metadata (exists/size/mode) still passes so a bot can reason about
 * posture (Van Helsing's job) without reading secret values.
 */

import path from "node:path";

/**
 * Basename globs that are ALWAYS shrouded regardless of git status. gitignore
 * is the primary signal, but secrets also live in non-git trees and in files
 * that a sloppy `.gitignore` misses — so this list is an independent floor.
 * Only `*` is supported (matches any run of chars); everything else is literal.
 */
export const ALWAYS_SHROUD_GLOBS: readonly string[] = [
  ".env*",
  "*.key",
  "*.pem",
  "*.crt",
  "*.cer",
  "id_ed25519*",
  "id_rsa*",
  "id_ecdsa*",
  "id_dsa*",
  "credentials",
  "*.secret",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "*.jks",
  ".netrc",
  "*.ppk",
  "*.asc",
  "*.gpg",
  "ssh_host_*", // sshd host keys under /etc/ssh (ssh_host_ed25519_key, …)
  "*_key", // catch-all for *_key private keys not fitting id_*
  "*.ovpn",
  "*.kdbx",
  // CLAW-064 — openclaw's OWN credential files. All live under ~/.openclaw
  // (same-uid readable by the agent process) and each is a self-approve or
  // authority vector:
  //   .gateway-token    — the gateway auth token (crown jewel; scope-minting)
  //   openclaw.json     — carries `gateway.auth.token` inline as plaintext
  //   exec-approvals.json — holds the approval-runtime SOCKET token, whose
  //                         HMAC lets a same-uid loopback client register AND
  //                         self-resolve exec approvals (see design §7b)
  //   device.json / device-auth.json — the operator device's privateKeyPem /
  //                         issued deviceToken (see CLAW-061)
  // Names are specific enough that the false-positive risk in `/reach` is
  // minimal, and the alternative (adding `.openclaw` / `identity` as secret
  // segments) would over-shroud the agent's own workspace and any legit
  // "identity" directory in the knowledge base.
  ".gateway-token",
  "openclaw.json",
  "exec-approvals.json",
  "device.json",
  "device-auth.json",
];

/**
 * Path segments that are entirely secret — anything beneath them is shrouded
 * (contents withheld; metadata still passes so mode/existence audits work).
 * Includes the reach-mount RENAMES: ~/.ssh is bind-mounted as /reach/home-ssh
 * and ~/.gnupg as /reach/gnupg, so the on-container segment is `home-ssh`/
 * `gnupg`, NOT `.ssh`/`.gnupg` — without these, bare-named private keys under
 * the mount (e.g. `oasis_deploy`, `google_compute_engine`) that match no glob
 * would leak (found in the 2026-07-13 dry-run). `.aws` is deliberately absent:
 * `.aws/config` is allowed reach; only `.aws/credentials` is secret (glob).
 */
export const SECRET_SEGMENTS: readonly string[] = [
  ".ssh",
  ".gnupg",
  "home-ssh", // reach rename of ~/.ssh
  "gnupg", // reach rename of ~/.gnupg
];

export type ShroudReason =
  | "unlocked"
  | `always-glob:${string}`
  | `secret-dir:${string}`
  | "gitignored"
  | "visible";

export interface ShroudVerdict {
  shroud: boolean;
  reason: ShroudReason;
}

export interface ClassifyOptions {
  /** Absolute paths known to be gitignored (from discoverIgnored). */
  ignored: ReadonlySet<string>;
  /** Absolute paths unlocked for THIS session only (CLAW-044). */
  unlocked?: ReadonlySet<string>;
  alwaysGlobs?: readonly string[];
  secretSegments?: readonly string[];
}

/** Convert a `*`-only glob to an anchored, case-sensitive RegExp. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

const globCache = new Map<string, RegExp>();
function matchGlob(name: string, glob: string): boolean {
  let re = globCache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    globCache.set(glob, re);
  }
  return re.test(name);
}

/**
 * Decide whether an absolute path's CONTENTS should be shrouded. Order matters:
 * an explicit session unlock wins over everything; then the independent secret
 * floors (globs, secret dirs); then git status.
 */
export function classifyPath(absPath: string, opts: ClassifyOptions): ShroudVerdict {
  const norm = path.resolve(absPath);
  const unlocked = opts.unlocked ?? new Set<string>();
  if (unlocked.has(norm)) return { shroud: false, reason: "unlocked" };

  const base = path.basename(norm);
  const globs = opts.alwaysGlobs ?? ALWAYS_SHROUD_GLOBS;
  for (const g of globs) {
    if (matchGlob(base, g)) return { shroud: true, reason: `always-glob:${g}` };
  }

  const segments = norm.split(path.sep).filter(Boolean);
  const secretSegs = opts.secretSegments ?? SECRET_SEGMENTS;
  for (const seg of secretSegs) {
    if (segments.includes(seg)) return { shroud: true, reason: `secret-dir:${seg}` };
  }

  if (opts.ignored.has(norm)) return { shroud: true, reason: "gitignored" };

  return { shroud: false, reason: "visible" };
}

/** Minimal command runner the discovery step shells out through (injectable for tests). */
export type ExecFn = (
  cmd: string,
  args: string[],
) => { code: number; stdout: string; stderr: string };

/**
 * Build the gitignored-path set for a list of reach roots. Each root that is a
 * git repo contributes its ignored files (absolute); non-git roots contribute
 * nothing here (the glob/secret-dir floors and per-path check-ignore still
 * apply at classify time). Uses `-z` so newlines in paths never split entries.
 */
export function discoverIgnored(roots: readonly string[], exec: ExecFn): Set<string> {
  const out = new Set<string>();
  for (const root of roots) {
    const abs = path.resolve(root);
    const res = exec("git", [
      "-C",
      abs,
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ]);
    if (res.code !== 0) continue; // not a git repo, or git error → skip; floors still apply
    for (const rel of res.stdout.split("\0")) {
      if (rel) out.add(path.resolve(abs, rel));
    }
  }
  return out;
}

/**
 * Fallback per-path check for a path not covered by the pre-built manifest
 * (e.g. a file created after session start). Returns true if git reports it
 * ignored. Cheap enough to call on the miss path only.
 */
export function checkIgnoredLive(absPath: string, exec: ExecFn): boolean {
  const dir = path.dirname(path.resolve(absPath));
  const res = exec("git", ["-C", dir, "check-ignore", "-q", "--", absPath]);
  return res.code === 0; // git check-ignore: exit 0 == path is ignored
}
