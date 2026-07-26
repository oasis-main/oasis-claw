import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

// ── Layer 1: HARD CONSTRAINTS (§6a of .swarm/UNIFIED_REVIEWER.md) ──────────────
// Deterministic, no model call. The gitignore-membership check is authoritative
// (shells out to `git check-ignore`, which honors nested .gitignore + negation).
// This is the floor Layer 2 (constitution) can only tighten, never loosen.

export type Verdict = "allow" | "deny" | "escalate";

export interface Decision {
  verdict: Verdict;
  principle: string; // which hard rule fired (or "hard:default-allow")
  reason: string;
}

export interface HardPolicy {
  // File-tool READ of these globs is always denied (never read, even "to help").
  denyReadGlobs: string[];
  // File-tool WRITE under these absolute roots is denied (control-plane).
  denyWriteRoots: string[];
  // Verdict for a WRITE to a gitignored path. Design default: "escalate".
  gitignoredWrite: Verdict;
  // Verdict for a compound/pipe/redirect exec argv the layer can't cleanly parse.
  compoundExec: Verdict;
}

export const DEFAULT_HARD_POLICY: HardPolicy = {
  denyReadGlobs: ["*.pem", "id_*", "*.key", "*_rsa", "*_ed25519"],
  denyWriteRoots: ["/reach/runes/oasis-x/oasis-claw"],
  gitignoredWrite: "escalate",
  compoundExec: "escalate",
};

const ALLOW: Decision = { verdict: "allow", principle: "hard:default-allow", reason: "" };

// Known-destructive command shapes → hard deny regardless of allowlist.
const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b.*\s\/(?:\s|$|\*)/, // rm -rf / (root)
  /\brm\s+-[a-z]*[rf][a-z]*\s+(--no-preserve-root|\/)\b/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd)/,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
  /\bshred\b|\bwipefs\b/,
  />\s*\/dev\/(sd|nvme|disk|hd)\w*/,
  /\bchmod\s+-R\s+0*\s+\//,
];

// Shell metacharacters that make an argv un-parseable for a clean allowlist match
// → route to the human (carry-over guardrail; pipes/redirects stay human).
const COMPOUND = /[|;&]|\$\(|`|(^|\s)>{1,2}(\s|$)|<\(/;

function basename(p: string): string {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

// Minimal glob (supports leading * and trailing *). Matches against basename.
function globMatch(glob: string, name: string): boolean {
  if (glob.startsWith("*") && glob.endsWith("*") && glob.length > 1) {
    return name.includes(glob.slice(1, -1));
  }
  if (glob.startsWith("*")) return name.endsWith(glob.slice(1));
  if (glob.endsWith("*")) return name.startsWith(glob.slice(0, -1));
  return name === glob;
}

function underRoot(absPath: string, root: string): boolean {
  const a = absPath.replace(/\/+$/, "");
  const r = root.replace(/\/+$/, "");
  return a === r || a.startsWith(r + "/");
}

/** Authoritative gitignore check. True iff `absPath` is ignored by the git repo
 * that contains it. Not-a-repo / errors → false (gitignore doesn't apply). */
export function isGitignored(absPath: string): boolean {
  try {
    // check-ignore works on not-yet-existing paths (that's the point — we check
    // BEFORE the write), but the cwd must be inside the work tree. Walk up to the
    // nearest EXISTING ancestor directory.
    let cwd = dirname(absPath);
    while (cwd !== "/" && cwd !== "." && !existsSync(cwd)) cwd = dirname(cwd);
    // --quiet: exit 0 if ignored, 1 if not, 128 if not a work tree / error.
    execFileSync("git", ["-C", cwd, "check-ignore", "--quiet", "--", absPath], {
      stdio: "ignore",
      timeout: 3000,
    });
    return true; // exit 0
  } catch (err) {
    const code = (err as { status?: number }).status;
    // 1 = explicitly not ignored; anything else (128 not-a-repo, spawn error,
    // timeout) → treat as not-gitignored (fail-open ONLY for the classifier; the
    // caller still applies its other hard rules). Layer 2 remains the backstop.
    return code === 0;
  }
}

const READ_TOOLS = /read|fetch|dir|list|cat|stat|grep/i;
const WRITE_TOOLS = /write|edit|patch|create|append|mkdir|mv|cp|rm|delete/i;

function firstString(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

export interface EvalInput {
  family: "exec" | "file" | "web" | "other";
  toolName: string;
  params: Record<string, unknown> | undefined;
  derivedPaths: readonly string[] | undefined;
}

/** Evaluate the hard layer. Pure + deterministic apart from the git subprocess. */
export function evaluateHard(input: EvalInput, policy: HardPolicy = DEFAULT_HARD_POLICY): Decision {
  const params = input.params ?? {};

  if (input.family === "exec") {
    const cmd = firstString(params, "command", "cmd", "script", "input", "code");
    if (cmd) {
      for (const re of DESTRUCTIVE) {
        if (re.test(cmd)) {
          return { verdict: "deny", principle: "hard:destructive-exec", reason: `refusing destructive command: ${cmd.slice(0, 120)}` };
        }
      }
      if (COMPOUND.test(cmd)) {
        return { verdict: policy.compoundExec, principle: "hard:compound-exec", reason: `compound/redirect argv routed to human: ${cmd.slice(0, 120)}` };
      }
    }
    return ALLOW; // allowlist enforcement is openclaw's job; we add the two rules above
  }

  if (input.family === "file") {
    const paths = input.derivedPaths && input.derivedPaths.length > 0
      ? [...input.derivedPaths]
      : [firstString(params, "path", "file", "filePath", "file_path", "target")].filter(Boolean);

    const isWrite = WRITE_TOOLS.test(input.toolName) || "content" in params || "text" in params;
    const isRead = !isWrite && READ_TOOLS.test(input.toolName);

    for (const p of paths) {
      if (isWrite) {
        for (const root of policy.denyWriteRoots) {
          if (underRoot(p, root)) {
            return { verdict: "deny", principle: "hard:deny-write-control-plane", reason: `write to control-plane path denied: ${p}` };
          }
        }
        if (isGitignored(p)) {
          return { verdict: policy.gitignoredWrite, principle: "hard:gitignored-write", reason: `write to a .gitignored path: ${p}` };
        }
      }
      if (isRead) {
        const name = basename(p);
        for (const g of policy.denyReadGlobs) {
          if (globMatch(g, name)) {
            return { verdict: "deny", principle: "hard:deny-read-secret", reason: `read of a protected file denied: ${p}` };
          }
        }
      }
    }
    return ALLOW;
  }

  // web + other: egress proxy owns host policy; the hard layer has nothing to add.
  return ALLOW;
}
