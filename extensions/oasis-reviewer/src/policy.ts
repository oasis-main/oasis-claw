import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";

// ── Layer 1: HARD CONSTRAINTS (§6a of .swarm/UNIFIED_REVIEWER.md) ──────────────
// Deterministic, no model call. Loads the authored policy (reviewer-policy.json:
// fleet defaults + per-bot rules) and evaluates each call. Layer 2 (constitution)
// is the model-judged layer that only tightens this floor.

export type Verdict = "allow" | "deny" | "escalate";

export interface Decision {
  verdict: Verdict;
  principle: string;
  reason: string;
}

// Resolved per-bot policy = fleet ∪ per_bot[botKey], flattened for evaluation.
export interface HardPolicy {
  denyReadGlobs: string[];
  denyWriteRoots: string[]; // control-plane (always deny) — fleet-level
  gitignoredWrite: Verdict;
  compoundExec: Verdict;
  destructiveExec: Verdict;
  // per-bot write scoping
  allowWriteRoots: string[]; // [] = no scoping (fleet-broad)
  escalateWriteRoots: string[];
  denyWriteOutsideAllow: boolean;
  // exec commands matching any of these regexes → escalate (operator-consent)
  escalateExecRegex: RegExp[];
}

export const DEFAULT_HARD_POLICY: HardPolicy = {
  denyReadGlobs: ["*.pem", "id_*", "*.key", "*_rsa", "*_ed25519"],
  denyWriteRoots: ["/reach/runes/oasis-x/oasis-claw"],
  gitignoredWrite: "escalate",
  compoundExec: "escalate",
  destructiveExec: "deny",
  allowWriteRoots: [],
  escalateWriteRoots: [],
  denyWriteOutsideAllow: false,
  escalateExecRegex: [],
};

const ALLOW: Decision = { verdict: "allow", principle: "hard:default-allow", reason: "" };

const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b.*\s\/(?:\s|$|\*)/,
  /\brm\s+-[a-z]*[rf][a-z]*\s+(--no-preserve-root|\/)\b/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd)/,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /\bshred\b|\bwipefs\b/,
  />\s*\/dev\/(sd|nvme|disk|hd)\w*/,
  /\bchmod\s+-R\s+0*\s+\//,
];
const COMPOUND = /[|;&]|\$\(|`|(^|\s)>{1,2}(\s|$)|<\(/;

// ── Policy file loading + per-bot resolution ──────────────────────────────────

interface PolicyFile {
  botAliases?: Record<string, string>;
  constitution?: {
    fleet?: string[];
    per_bot?: Record<string, string[]>;
  };
  hard?: {
    fleet?: {
      denyReadGlobs?: string[];
      destructiveExec?: Verdict;
      compoundExec?: Verdict;
      gitignoredWrite?: Verdict;
      escalateExecPatterns?: Record<string, string>;
    };
    per_bot?: Record<
      string,
      {
        allowWriteRoots?: string[];
        escalateWriteRoots?: string[];
        denyWriteOutsideAllow?: boolean;
        escalateActions?: string[];
        escalateExtra?: Record<string, string>;
        constitutionalReviewRequired?: boolean;
      }
    >;
  };
}

let cachedPolicy: PolicyFile | null | undefined;

export function loadPolicyFile(path: string): PolicyFile | null {
  if (cachedPolicy !== undefined) return cachedPolicy;
  try {
    cachedPolicy = JSON.parse(readFileSync(path, "utf8")) as PolicyFile;
  } catch {
    cachedPolicy = null;
  }
  return cachedPolicy;
}

/** Normalize OASIS_AGENT_NAME → bot key ("Yes Man" → "yesman"). */
export function botKeyFor(agentName: string, aliases?: Record<string, string>): string {
  if (aliases && aliases[agentName]) return aliases[agentName];
  return agentName.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Constitution principles for a bot = fleet ∪ per_bot. */
export function constitutionFor(policy: PolicyFile | null, botKey: string): string[] {
  const fleet = policy?.constitution?.fleet ?? [];
  const perBot = policy?.constitution?.per_bot?.[botKey] ?? [];
  return [...fleet, ...perBot];
}

export function constitutionalReviewRequired(policy: PolicyFile | null, botKey: string): boolean {
  return policy?.hard?.per_bot?.[botKey]?.constitutionalReviewRequired === true;
}

/** Resolve the flat HardPolicy for a bot from the loaded file (fleet + per_bot). */
export function resolveHardPolicy(policy: PolicyFile | null, botKey: string): HardPolicy {
  if (!policy?.hard) return DEFAULT_HARD_POLICY;
  const f = policy.hard.fleet ?? {};
  const b = policy.hard.per_bot?.[botKey] ?? {};
  const patterns = f.escalateExecPatterns ?? {};
  const regex: RegExp[] = [];
  for (const key of b.escalateActions ?? []) {
    const src = patterns[key];
    if (src) regex.push(new RegExp(src, "i"));
  }
  for (const src of Object.values(b.escalateExtra ?? {})) {
    try {
      regex.push(new RegExp(src, "i"));
    } catch {
      /* skip a malformed per-bot pattern rather than fail the whole policy */
    }
  }
  return {
    denyReadGlobs: f.denyReadGlobs ?? DEFAULT_HARD_POLICY.denyReadGlobs,
    denyWriteRoots: DEFAULT_HARD_POLICY.denyWriteRoots,
    gitignoredWrite: f.gitignoredWrite ?? "escalate",
    compoundExec: f.compoundExec ?? "escalate",
    destructiveExec: f.destructiveExec ?? "deny",
    allowWriteRoots: b.allowWriteRoots ?? [],
    escalateWriteRoots: b.escalateWriteRoots ?? [],
    denyWriteOutsideAllow: b.denyWriteOutsideAllow === true,
    escalateExecRegex: regex,
  };
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function basename(p: string): string {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
function globMatch(glob: string, name: string): boolean {
  if (glob.startsWith("*") && glob.endsWith("*") && glob.length > 1) return name.includes(glob.slice(1, -1));
  if (glob.startsWith("*")) return name.endsWith(glob.slice(1));
  if (glob.endsWith("*")) return name.startsWith(glob.slice(0, -1));
  return name === glob;
}
function underRoot(absPath: string, root: string): boolean {
  const a = absPath.replace(/\/+$/, "");
  const r = root.replace(/\/+$/, "");
  return a === r || a.startsWith(r + "/");
}
/** Resolve a possibly-relative path against a cwd hint (RELATIVE PATHS principle). */
export function resolveTarget(p: string, cwd: string | undefined): string {
  if (!p) return p;
  if (isAbsolute(p)) return p;
  return resolvePath(cwd && isAbsolute(cwd) ? cwd : "/", p);
}

export function isGitignored(absPath: string): boolean {
  try {
    let cwd = dirname(absPath);
    while (cwd !== "/" && cwd !== "." && !existsSync(cwd)) cwd = dirname(cwd);
    execFileSync("git", ["-C", cwd, "check-ignore", "--quiet", "--", absPath], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch (err) {
    return (err as { status?: number }).status === 0;
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

export function evaluateHard(input: EvalInput, policy: HardPolicy = DEFAULT_HARD_POLICY): Decision {
  const params = input.params ?? {};
  const cwd = firstString(params, "cwd", "workingDir", "dir") || undefined;

  if (input.family === "exec") {
    const cmd = firstString(params, "command", "cmd", "script", "input", "code");
    if (cmd) {
      for (const re of DESTRUCTIVE) {
        if (re.test(cmd)) return { verdict: policy.destructiveExec, principle: "hard:destructive-exec", reason: `refusing destructive command: ${cmd.slice(0, 120)}` };
      }
      for (const re of policy.escalateExecRegex) {
        if (re.test(cmd)) return { verdict: "escalate", principle: "hard:operator-consent-action", reason: `action needs Mike's slash-command approval: ${cmd.slice(0, 120)}` };
      }
      if (COMPOUND.test(cmd)) return { verdict: policy.compoundExec, principle: "hard:compound-exec", reason: `compound/redirect argv routed to human: ${cmd.slice(0, 120)}` };
    }
    return ALLOW;
  }

  if (input.family === "file") {
    const rawPaths =
      input.derivedPaths && input.derivedPaths.length > 0
        ? [...input.derivedPaths]
        : [firstString(params, "path", "file", "filePath", "file_path", "target")].filter(Boolean);
    const paths = rawPaths.map((p) => resolveTarget(p, cwd));

    const isWrite = WRITE_TOOLS.test(input.toolName) || "content" in params || "text" in params;
    const isRead = !isWrite && READ_TOOLS.test(input.toolName);

    for (const p of paths) {
      if (isWrite) {
        for (const root of policy.denyWriteRoots) {
          if (underRoot(p, root)) return { verdict: "deny", principle: "hard:deny-write-control-plane", reason: `write to control-plane path denied: ${p}` };
        }
        if (policy.denyWriteOutsideAllow && policy.allowWriteRoots.length > 0) {
          const inScope = policy.allowWriteRoots.some((r) => underRoot(p, r));
          if (!inScope) return { verdict: "deny", principle: "hard:write-out-of-scope", reason: `write outside this bot's allowed roots (${policy.allowWriteRoots.join(", ")}) denied: ${p}` };
        }
        for (const root of policy.escalateWriteRoots) {
          if (underRoot(p, root)) return { verdict: "escalate", principle: "hard:escalate-write-root", reason: `write to a slash-approval-gated path: ${p}` };
        }
        if (isGitignored(p)) return { verdict: policy.gitignoredWrite, principle: "hard:gitignored-write", reason: `write to a .gitignored path: ${p}` };
      }
      if (isRead) {
        const name = basename(p);
        for (const g of policy.denyReadGlobs) {
          if (globMatch(g, name)) return { verdict: "deny", principle: "hard:deny-read-secret", reason: `read of a protected file denied: ${p}` };
        }
      }
    }
    return ALLOW;
  }

  return ALLOW;
}
