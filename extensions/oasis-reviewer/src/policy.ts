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
  compoundExec: Verdict; // benign pipes/redirects/&&/|| (substitution handled separately)
  substitutionExec: Verdict; // $( ) ` <( )  — eval vector
  destructiveExec: Verdict;
  // per-bot write scoping
  allowWriteRoots: string[]; // [] = no scoping (fleet-broad)
  escalateWriteRoots: string[];
  denyWriteOutsideAllow: boolean;
  // exec commands matching any of these regexes → escalate (operator-consent)
  escalateExecRegex: RegExp[];
  // SELF-MODIFICATION backstop, kept SEPARATE from escalateExecRegex so it carries
  // its own principle (hard:self-runtime). Two reasons: (1) the audit used to label
  // a `gog` call "operator-consent-action", which was actively misleading during the
  // 2026-07-29 cron incident; (2) unattended runs may auto-downgrade ordinary
  // escalations, and this one must NEVER be downgraded (see NEVER_DOWNGRADE).
  selfRuntimeExecRegex: RegExp[];
}

export const DEFAULT_HARD_POLICY: HardPolicy = {
  denyReadGlobs: ["*.pem", "id_*", "*.key", "*_rsa", "*_ed25519"],
  denyWriteRoots: ["/reach/runes/oasis-x/oasis-claw"],
  gitignoredWrite: "escalate",
  compoundExec: "escalate",
  substitutionExec: "escalate",
  destructiveExec: "deny",
  allowWriteRoots: [],
  escalateWriteRoots: [],
  denyWriteOutsideAllow: false,
  escalateExecRegex: [],
  selfRuntimeExecRegex: [],
};

// Cron job MUTATION actions on openclaw's native `cron` agent tool
// (src/agents/tools/cron-tool.ts CRON_ACTIONS = status|list|add|update|remove|run|
// runs|wake). add/update/remove change WHAT runs unattended later, so they are the
// authoring-time consent point: gate these, and an unattended run needs no
// per-call approval (CLAW-078). status/list/runs are reads; run/wake only trigger
// an ALREADY-approved job, so both stay allow.
const CRON_MUTATE_ACTIONS = new Set(["add", "update", "remove"]);

// Escalations that must NEVER be auto-downgraded to allow in an unattended run.
// Everything else may be downgraded (an unattended escalate is otherwise a
// guaranteed fail-closed deny — nobody is there to answer). These two are the
// privilege-escalation paths: a cron/webhook turn that can rewrite its own runtime
// (`openclaw config set`) or author new cron jobs would be self-perpetuating, so
// unattended they FAIL CLOSED (deny) instead.
export const NEVER_DOWNGRADE = new Set(["hard:self-runtime", "hard:cron-mutation"]);

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
// Download/decode → shell execution (obfuscated RCE): fetched or decoded content
// piped/chained INTO a shell interpreter. Hard-deny even on a reviewer-gated bot
// (a legit install is done in inspectable steps, or by Mike).
const DOWNLOAD_EXEC = /(?:\||&&|;)\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh)\b|(?:^|\s|;|&|\|)eval\s+\S/i;
// Command / process substitution = an eval vector that evades static inspection —
// route to a human even on a reviewer-gated bot.
const SUBSTITUTION = /\$\(|`|<\(/;
// Benign shell composition: pipes, sequencing, output redirects. On a reviewer-
// gated bot (Mike, 2026-07-27) these RUN — destructive / download-exec /
// substitution are handled above; the write-target residual is the same one
// mode=full already accepts. Deliberately excludes $( ` <( (see SUBSTITUTION).
const BENIGN_COMPOUND = /[|;&]|(^|\s)>{1,2}(\s|$)/;

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
      substitutionExec?: Verdict;
      gitignoredWrite?: Verdict;
      escalateExecPatterns?: Record<string, string>;
      escalateExecAlways?: Record<string, string>; // fleet-always (no per-bot opt-in)
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
  // SELF-MODIFICATION backstop (fleet invariant, ALWAYS on — no per-bot opt-in):
  // exec commands that drive the bot's OWN openclaw runtime CLI → escalate. This
  // is the Layer 1 deterministic floor under the constitution's no-self-
  // modification principle, and it is load-bearing the moment a bot runs
  // mode=full (reviewer-gated exec): without an allowlist, `openclaw config set`
  // in a live container would otherwise default-allow and drift the config into a
  // crash. Fleet-wide because "a bot must not rewrite its own runtime" holds for
  // every bot, not just the ones that opted into escalateActions.
  const selfRuntime: RegExp[] = [];
  for (const src of Object.values(f.escalateExecAlways ?? {})) {
    try {
      selfRuntime.push(new RegExp(src, "i"));
    } catch {
      /* skip a malformed fleet pattern rather than fail the whole policy */
    }
  }
  return {
    denyReadGlobs: f.denyReadGlobs ?? DEFAULT_HARD_POLICY.denyReadGlobs,
    denyWriteRoots: DEFAULT_HARD_POLICY.denyWriteRoots,
    gitignoredWrite: f.gitignoredWrite ?? "escalate",
    compoundExec: f.compoundExec ?? "escalate",
    substitutionExec: f.substitutionExec ?? "escalate",
    destructiveExec: f.destructiveExec ?? "deny",
    allowWriteRoots: b.allowWriteRoots ?? [],
    escalateWriteRoots: b.escalateWriteRoots ?? [],
    denyWriteOutsideAllow: b.denyWriteOutsideAllow === true,
    escalateExecRegex: regex,
    selfRuntimeExecRegex: selfRuntime,
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

  // ── Cron authoring is the consent point (CLAW-078) ──
  // Gate MUTATIONS of the schedule itself (add/update/remove on openclaw's native
  // `cron` tool). Reviewing at authoring time is what lets an unattended RUN skip
  // per-call approval: Mike approves what will run, once, while he is present.
  // Checked before the family dispatch because `cron` classifies as "other".
  if (input.toolName === "cron") {
    const action = firstString(params, "action").toLowerCase();
    if (CRON_MUTATE_ACTIONS.has(action)) {
      return {
        verdict: "escalate",
        principle: "hard:cron-mutation",
        reason: `cron ${action} changes what runs unattended later — needs Mike's approval`,
      };
    }
    return ALLOW; // status | list | runs | run | wake
  }

  if (input.family === "exec") {
    const cmd = firstString(params, "command", "cmd", "script", "input", "code");
    if (cmd) {
      for (const re of DESTRUCTIVE) {
        if (re.test(cmd)) return { verdict: policy.destructiveExec, principle: "hard:destructive-exec", reason: `refusing destructive command: ${cmd.slice(0, 120)}` };
      }
      if (DOWNLOAD_EXEC.test(cmd)) return { verdict: "deny", principle: "hard:download-execute", reason: `refusing pipe/decode into a shell (obfuscated RCE): ${cmd.slice(0, 120)}` };
      for (const re of policy.selfRuntimeExecRegex) {
        if (re.test(cmd)) return { verdict: "escalate", principle: "hard:self-runtime", reason: `driving this bot's own openclaw runtime needs Mike's approval: ${cmd.slice(0, 120)}` };
      }
      for (const re of policy.escalateExecRegex) {
        if (re.test(cmd)) return { verdict: "escalate", principle: "hard:operator-consent-action", reason: `action needs Mike's slash-command approval: ${cmd.slice(0, 120)}` };
      }
      if (SUBSTITUTION.test(cmd)) return { verdict: policy.substitutionExec, principle: "hard:command-substitution", reason: `command/process substitution routed to human: ${cmd.slice(0, 120)}` };
      if (BENIGN_COMPOUND.test(cmd)) return { verdict: policy.compoundExec, principle: "hard:compound-exec", reason: `compound/redirect: ${cmd.slice(0, 120)}` };
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
        // Write-scoping applies to MIKE's real filesystem (/reach/*) only. A bot's
        // own container-private dirs — /home/node/.openclaw (memory + workspace),
        // /report, /tmp, its work volumes — are always its to write: the rootfs is
        // read-only and the control-plane deny above already fences oasis-claw, so
        // nothing sensitive lives outside /reach to protect. WITHOUT this gate, a
        // scoped bot whose allowWriteRoots only names /reach paths would have its OWN
        // memory writes denied as "out of scope" — the enforce brick that stops a bot
        // from functioning at all (CLAW-074 companion-reach rollout).
        if (policy.denyWriteOutsideAllow && policy.allowWriteRoots.length > 0 && underRoot(p, "/reach")) {
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
