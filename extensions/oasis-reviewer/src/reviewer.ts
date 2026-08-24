import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  botKeyFor,
  CONSENT_SATISFIABLE,
  constitutionalReviewRequired,
  constitutionFor,
  DEFAULT_HARD_POLICY,
  evaluateHard,
  execCommandOf,
  isInertReadOnlyPipelineForL2Backstop,
  isInertReadOnlyToolCall,
  loadPolicyFile,
  NEVER_DOWNGRADE,
  resolveHardPolicy,
  type Decision,
  type HardPolicy,
  type Verdict,
} from "./policy.js";
import {
  judgeConstitution,
  judgeInjectionReport,
  type InjectionReviewDecision,
  type InjectionReviewInput,
  type InjectionReviewVerdict,
  type Layer2Decision,
  type LlmComplete,
} from "./layer2.js";
import { sendTelegramMessage } from "./telegram.js";
import { fallbackSessionFilePath, readSessionTranscriptSummary } from "./transcript.js";

// Layer 2 concurrency cap — bound the number of in-flight model judgments so a
// burst of ambiguous calls can't spawn dozens of top-tier completions at once.
const L2_MAX_INFLIGHT = 3;
let l2InFlight = 0;

// ── Unattended runs (CLAW-078) ────────────────────────────────────────────────
// An escalate needs a human. In a cron- or webhook-triggered turn there is none,
// so `requireApproval` just burns its timeout and fail-closes to deny — which is
// how the 2026-07-29 Nimbus regression presented (working cron jobs "rejected").
// openclaw tags those turns via the hook context's sessionKey:
//   cron:<jobId>   gateway/server-cron.ts:226, cron/isolated-agent/run.ts:496
//   hook:<uuid>    gateway/hooks.ts:345 (inbound webhook-triggered session)
// Consent moves to AUTHORING time (hard:cron-mutation gates add/update/remove),
// so at run time an ordinary escalate downgrades to allow. NEVER_DOWNGRADE
// escalations still fail closed. Overridable per bot without a rebuild.
// Markers are matched as SEGMENTS (see isUnattended) because the live key is
// agent-namespaced: `agent:main:cron:<jobId>`.
// KNOWN GAP: a cron job with an explicit sessionTarget gets that session's key
// instead of a cron: segment (cron/session-target.ts:18) — verified live: jobs with
// sessionTarget "main" deliver into the main session, where an approval CAN reach
// Mike, so treating those as attended is correct. Heartbeat turns still have no
// distinct segment. Every audit row records sessionKey, so any further trigger
// shapes can be read off live data instead of guessed at.
const UNATTENDED_PREFIXES = (process.env.OASIS_REVIEWER_UNATTENDED_PREFIXES ?? "cron:,hook:")
  .split(",")
  .map((p) => p.trim())
  .filter((p) => p.length > 0);

// Match the marker as a SEGMENT, not just a leading prefix. The keys openclaw
// BUILDS are bare (`cron:<jobId>` at gateway/server-cron.ts:226), but by the time
// one reaches the hook context it has been namespaced per agent — observed live
// 2026-07-30: `agent:main:cron:78991974-1e56-…`. A startsWith("cron:") test
// therefore returned FALSE on every real cron call and the downgrade never fired.
// The bug was invisible because the same deploy also fixed the false-positive that
// was causing the escalations, so the jobs passed without needing the downgrade.
function isUnattended(sessionKey: string): boolean {
  return UNATTENDED_PREFIXES.some((p) => sessionKey.startsWith(p) || sessionKey.includes(`:${p}`));
}

// ── Operator-request capture (CLAW-079) ───────────────────────────────────────
// before_tool_call sees a bare tool call: name, params, paths. It cannot see what
// Mike ASKED for, so the judge had no way to tell a requested action from one the
// bot invented — and on 2026-07-30 it escalated a Gmail send Mike had just approved
// out loud, reasoning (correctly, on the evidence it had) that an irreversible
// outbound action "warrants explicit operator sign-off".
// The `llm_input` hook carries `prompt` — the operator's turn — and both hooks
// share `ctx.runId`, so we stash the request per run and hand it to the judge.
// Requires hooks.allowConversationAccess (already set in the entrypoint).
// For an unattended cron run the "prompt" is the job's authored payload, which is
// exactly the instruction Mike approved when the job was created — so the same
// mechanism supplies consent evidence there too.
const REQUEST_CACHE_MAX = 64;
const REQUEST_MAX_CHARS = 1500;
const requestByRun = new Map<string, string>();

// ── Standing task across run boundaries (CLAW-103, 2026-08-20) ───────────────
// requestByRun above is keyed by RUN. A run ends when a turn fails mid-flight
// ("[assistant turn failed before producing content]") or the operator's
// message arrives garbled/truncated. The next message opens a NEW run with a
// NEW runId, so the lookup below found only that run's own first prompt — a
// short follow-up — and the judge lost the work actually underway.
//
// Confirmed twice in a deployment's reviewer-audit.jsonl, both citing only the short
// follow-up in their stated reason:
//   2026-08-14 — a read-only `find`/`grep` survey escalated as "explores an
//     unrelated repo ... no connection to Mike's stated request", right after a
//     turn failure; the survey served the broader ask from earlier turns.
//   2026-08-18 — a `git stash` and a file edit escalated as "operator's message
//     is only a question about a 'slop-cop check'" and "message is
//     garbled/interrupted ... gives no clear instruction", during an
//     in-progress bugfix verification.
// In both, detecting the fragment was CORRECT behavior; having no path back to
// the standing task was the defect.
//
// Deliberately a SECOND map rather than a change to the per-run one. The
// consent-downgrade at the Layer 2 call site keys on the per-run request
// specifically — "he asked for it THIS run" — and must not be satisfiable by a
// stale ask from earlier in the session. Keeping the two separate makes that
// distinction structural instead of a comment nobody re-reads.
const STANDING_CACHE_MAX = 64;
// Length is a crude proxy for "this is a real instruction, not a fragment".
// Chosen because the two confirmed failures were a 14-character question and a
// truncated send, while genuine asks in the same logs run to whole paragraphs.
// A misjudgment here is SAFE in both directions: too low and the judge sees a
// slightly noisier standing block alongside this run's own turn; too high and
// it simply falls back to today's behavior. It can never suppress or override
// the run's own request, which is always sent.
const STANDING_MIN_CHARS = 120;
const standingBySession = new Map<string, string>();

// ── Bot's own last message across a run boundary (2026-08-24) ────────────────
// Generalizes a real trade-approval incident: House proposed a specific order
// in full, Mike replied "go for it", and the Layer 2 judge escalated it anyway
// — reasoning correctly over an INCOMPLETE picture. operatorRequest and
// standingRequest above only ever capture MIKE's own words (llm_input only
// fires for the operator's turn), so the judge never saw House's own proposal
// that "go for it" was actually confirming. A short reply with no visible
// antecedent reads as "a bare approval fragment", even when a human reading
// the same chat would recognize it instantly.
//
// Captured from before_agent_finalize's lastAssistantMessage — the SAME event
// the loop guard below already consumes, for a different purpose. Kept as its
// own single-slot-per-session cache (not folded into standingBySession) because
// this is the bot's OWN words, not the operator's, and the two must never be
// presented to the judge as if they were the same kind of evidence.
const LAST_ASSISTANT_CACHE_MAX = 64;
const LAST_ASSISTANT_MAX_CHARS = 1500;
const lastAssistantMessageBySession = new Map<string, string>();

function rememberLastAssistantMessage(sessionId: string, text: string): void {
  if (!sessionId || !text.trim()) return;
  const trimmed = text.trim().slice(0, LAST_ASSISTANT_MAX_CHARS);
  // Delete-then-set moves this session to the end of insertion order, same as
  // rememberRequest's standing-task cache — an active session must never be
  // the one evicted just because it was least-recently-inserted.
  lastAssistantMessageBySession.delete(sessionId);
  evictOldest(lastAssistantMessageBySession, LAST_ASSISTANT_CACHE_MAX);
  lastAssistantMessageBySession.set(sessionId, trimmed);
}

function evictOldest(cache: Map<string, string>, max: number): void {
  if (cache.size < max) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

function rememberRequest(runId: string, sessionId: string, prompt: string): void {
  if (!prompt) return;
  const trimmed = prompt.slice(0, REQUEST_MAX_CHARS);
  if (runId && !requestByRun.has(runId)) {
    // Keep the FIRST prompt of a run: that is the ask. Later ReAct steps re-enter
    // this hook and would otherwise overwrite it with intermediate state.
    evictOldest(requestByRun, REQUEST_CACHE_MAX);
    requestByRun.set(runId, trimmed);
  }
  // The session's standing task, by contrast, tracks the LATEST substantive ask
  // — a new real instruction supersedes an older one, so the judge is never
  // reasoning from a task Mike has already moved on from. Short prompts never
  // overwrite it, which is exactly what keeps a "slop-cop check" from erasing
  // the work it was asking about.
  if (sessionId && prompt.trim().length >= STANDING_MIN_CHARS) {
    // Delete first so re-setting moves this session to the end of the insertion
    // order; without it the eviction above would treat a long-running, actively
    // updated session as the oldest and drop it.
    standingBySession.delete(sessionId);
    evictOldest(standingBySession, STANDING_CACHE_MAX);
    standingBySession.set(sessionId, trimmed);
  }
}

// ── Repeated-reply loop guard (CLAW-13x, 2026-08-13 House incident) ──────────
// House spun for ~14 minutes sending near-identical replies with no automatic
// stop: a hung Layer 2 check (see l2Ms in the audit log) tripped the session
// write-lock's 5-minute force-release, and the retry re-entered with the same
// stale context on every attempt. Nothing anywhere detected "the assistant
// just sent the same reply again" and stopped it.
// Same off|shadow|enforce convention as Layer 2 above, and same default: OFF.
// shadow logs a `phase:"loop_guard"` row without acting; enforce also returns
// {action:"finalize"} from before_agent_finalize to end the turn instead of
// letting it repeat again. History is in-memory only (per-process, per
// sessionId), bounded the same way requestByRun is bounded below — a spin is
// a live-process phenomenon, nothing here needs to survive a restart.
// Mode/threshold are read fresh inside registerReviewer (below), same as
// Layer 2's env vars — NOT module-level consts, so a re-register (e.g. in
// tests) picks up the current env rather than whatever was set at first
// import.
const LOOP_GUARD_HISTORY_MAX = 64;
const loopGuardHistory = new Map<string, { hash: string; streak: number }>();

/** Normalizes assistant text before hashing, so a small rewording still counts as a repeat. */
function normalizeForLoopGuard(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function hashForLoopGuard(text: string): string {
  return createHash("sha256").update(normalizeForLoopGuard(text)).digest("hex").slice(0, 16);
}

// Layer 2 may only ever TIGHTEN Layer 1 — the constitution is a second lock, not a
// key. A model that has just read attacker-controllable bytes must never be able to
// talk the deterministic layer down, so the combined verdict is the stricter of the
// two and a looser L2 opinion is discarded (recorded in the audit either way).
// The ONE author-controlled exception is CONSENT_SATISFIABLE (see policy.ts).
const STRICTNESS: Record<Verdict, number> = { allow: 0, escalate: 1, deny: 2 };

function tightenOnly(l1: Decision, l2: Layer2Decision): Decision {
  if (STRICTNESS[l2.verdict] <= STRICTNESS[l1.verdict]) return l1;
  return {
    verdict: l2.verdict,
    principle: `l2:${l2.principle || "constitution"}`,
    reason: l2.reason || `constitution tightened ${l1.verdict} → ${l2.verdict}`,
    // 2026-08-24: carry Layer 2's own retry guidance through the tightening —
    // see Layer2Decision.retryHint and the DESTRUCTIVE/DOWNLOAD_EXEC/
    // SUBSTITUTION static hints in policy.ts for the Layer 1 counterpart.
    retryHint: l2.retryHint,
  };
}

// ── Unified reviewer (.swarm/UNIFIED_REVIEWER.md) ──────────────────────────────
// before_tool_call hook → Layer 1 (hard, deterministic, per-bot from
// reviewer-policy.json) → Layer 2 (constitution, model-judged via
// runtime.llm.complete). L1 verdicts map to native returns: allow→void,
// deny→{block}, escalate→{requireApproval, timeoutBehavior:"deny"} (fail-closed).
// L2 is SHADOW-first (OASIS_REVIEWER_L2=off|shadow): it fires ASYNC (never blocks
// the hook) and only LOGS its verdict, so the constitution is calibrated before it
// enforces. Non-bundled plugins MUST declare hooks.allowConversationAccess
// (entrypoint) or the hook never fires.

export type ReviewerMode = "shadow" | "enforce";

export interface ReviewerOptions {
  auditDir: string;
  mode: ReviewerMode;
  policyFile?: string;
}

type ToolFamily = "exec" | "file" | "web" | "other";

function classifyTool(toolName: string, toolKind?: string, toolInputKind?: string): ToolFamily {
  const hint = `${toolKind ?? ""} ${toolInputKind ?? ""} ${toolName}`.toLowerCase();
  if (/(^|\b)(exec|shell|bash|command)\b/.test(hint)) return "exec";
  if (/(file|dir|read|write|edit|patch|fs|cat|stat|grep)\b/.test(hint)) return "file";
  if (/(web|fetch|search|http|url)\b/.test(hint)) return "web";
  return "other";
}

function subjectOf(family: ToolFamily, params: Record<string, unknown> | undefined, derivedPaths: readonly string[] | undefined): string {
  if (derivedPaths && derivedPaths.length > 0) return derivedPaths.join(" ");
  const o = params ?? {};
  const first = (...keys: string[]): string => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.length > 0) return v;
      if (Array.isArray(v)) return v.map(String).join(" ");
    }
    return "";
  };
  if (family === "exec") return first("command", "cmd", "argv", "script", "input", "code");
  if (family === "file") return first("path", "file", "filePath", "file_path", "target");
  if (family === "web") return first("url", "href", "query", "q", "target");
  return "";
}

function safeJson(value: unknown, max = 2000): string {
  try {
    const raw = JSON.stringify(value) ?? String(value);
    return raw.length > max ? raw.slice(0, max) + "…[truncated]" : raw;
  } catch {
    return "[unserializable]";
  }
}

// ── report_injection independent-review alert framing (2026-08-14) ──
// The agent's OWN report_injection alert (attack-logger.ts formatTelegramAlert)
// already reads "self-reported by the model — not independently verified" and is
// UNCHANGED by this feature — it keeps firing unconditionally. This is a SEPARATE,
// second message, sent only when injectionReviewMode is "enforce" and the judge
// returned a verdict, so Mike can tell at a glance whether the reviewer agrees.
const INJECTION_REVIEW_LABEL: Record<InjectionReviewVerdict, string> = {
  confirmed: "🔴 CONFIRMED — the reviewer independently agrees this looks like a real injection/social-engineering attempt.",
  unconfirmed: "🟢 NOT CONFIRMED — the reviewer believes this is a false positive (e.g. benign content, or something Mike actually asked for).",
  uncertain: "🟡 UNCERTAIN — the reviewer could not determine this either way.",
};

function formatInjectionReviewAlert(botKey: string, incidentType: string, decision: InjectionReviewDecision): string {
  return [
    `🔎 *oasis-reviewer independent verdict on a report_injection call*`,
    ``,
    `*Bot:* \`${botKey}\``,
    `*Self-reported incident type:* \`${incidentType}\``,
    `*Reviewer verdict:* ${INJECTION_REVIEW_LABEL[decision.verdict]}`,
    `*Reviewer reason:* ${decision.reason || "(none given)"}`,
    ``,
    `This is the reviewer's OWN independent read, separate from the bot's self-report alert above.`,
  ].join("\n");
}

export function registerReviewer(api: OpenClawPluginApi, opts: ReviewerOptions): void {
  const { auditDir, mode, policyFile } = opts;
  try {
    mkdirSync(auditDir, { recursive: true });
  } catch {
    /* never a hard dependency */
  }
  const auditFile = join(auditDir, "reviewer-audit.jsonl");
  const write = (row: Record<string, unknown>): void => {
    try {
      appendFileSync(auditFile, JSON.stringify(row) + "\n");
    } catch {
      /* best-effort */
    }
  };

  // Resolve this container's identity + per-bot policy once at register.
  const policy = policyFile ? loadPolicyFile(policyFile) : null;
  const agentName = process.env.OASIS_AGENT_NAME ?? "";
  const botKey = botKeyFor(agentName, policy?.botAliases);
  const hardPolicy: HardPolicy = policy ? resolveHardPolicy(policy, botKey) : DEFAULT_HARD_POLICY;
  const constitution = constitutionFor(policy, botKey);
  const alwaysConstitutional = constitutionalReviewRequired(policy, botKey);

  // Layer 2 (constitution, model-judged). SHADOW-first: OASIS_REVIEWER_L2 ∈
  // off | shadow | enforce. Uses the plugin runtime's llm.complete; degrades to off
  // if the runtime doesn't expose it. SHADOW is async/log-only. ENFORCE awaits the
  // judgment and lets it TIGHTEN the L1 verdict — that costs real latency per judged
  // call, which is the price of a verdict that can actually stop the call.
  const l2Mode = (process.env.OASIS_REVIEWER_L2 ?? "off").toLowerCase();
  const l2Model = process.env.OASIS_REVIEWER_MODEL || undefined; // default: agent's own model
  const l2All = process.env.OASIS_REVIEWER_L2_ALL === "1";
  // Enforce blocks the tool call on this call, so the default is tighter than the
  // shadow-era 20s: a judge that has not answered in 12s is treated as unavailable
  // (fail-closed for constitutionalReviewRequired bots, L1-fallback otherwise).
  const l2TimeoutMs = Number(process.env.OASIS_REVIEWER_L2_TIMEOUT_MS ?? "12000") || 12_000;
  // Raising thinking above "minimal" without raising maxTokens to match
  // reproduces the 2026-08-03 silent fail-closed-deny incident documented in
  // layer2.ts (extended thinking ate the whole budget, left nothing for the
  // verdict). Both must move together, so both default off the same absence.
  const l2Thinking = process.env.OASIS_REVIEWER_L2_THINKING || undefined; // default: layer2.ts's "minimal"
  const l2MaxTokens = process.env.OASIS_REVIEWER_L2_MAX_TOKENS
    ? Number(process.env.OASIS_REVIEWER_L2_MAX_TOKENS) || undefined
    : undefined; // default: layer2.ts's 2048
  // ── report_injection independent review (2026-08-14, House + Kolmogorov) ──
  // Own off|shadow|enforce switch, deliberately SEPARATE from OASIS_REVIEWER_L2 —
  // same reason the loop guard above got its own switch rather than riding L2's: Mike
  // can turn this on for a bot without also flipping that bot's ordinary tool-call
  // tightening. It never blocks report_injection (see the before_tool_call handler
  // below) — "enforce" here means "also send the reviewer's own Telegram alert", not
  // "gate the call". Default off, so no bot's behavior changes until Mike sets this
  // per-bot.
  const injectionReviewMode = (process.env.OASIS_REVIEWER_INJECTION_REVIEW ?? "off").toLowerCase();
  // Same shared per-bot env vars extensions/prompt-injection-reporting/index.ts reads
  // for its own Telegram alert, reused unchanged here so the reviewer's follow-up
  // alert lands in the SAME chat as the agent's self-report alert.
  const telegramBotToken = process.env.OASIS_TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.OASIS_TELEGRAM_CHAT_ID;
  const runtime = (
    api as unknown as {
      runtime?: {
        llm?: { complete?: LlmComplete };
        session?: { resolveSessionFilePath?: (sessionId: string, entry?: unknown, opts?: unknown) => string };
      };
    }
  ).runtime;
  // Available when EITHER switch wants it — injection review must not be starved of a
  // model just because OASIS_REVIEWER_L2 (ordinary tool-call tightening) is off for
  // this bot; the two features are independent by design (see above).
  const l2Complete: LlmComplete | undefined =
    (l2Mode !== "off" || injectionReviewMode !== "off") && typeof runtime?.llm?.complete === "function"
      ? (runtime.llm.complete.bind(runtime.llm) as LlmComplete)
      : undefined;
  if ((l2Mode !== "off" || injectionReviewMode !== "off") && !l2Complete) {
    api.logger.info("oasis-reviewer: Layer 2 / injection review requested but runtime.llm.complete unavailable — staying OFF");
  }

  // ── Context depth: three tiers of "how much conversation does the judge see" ──
  // (2026-08-24, Mike: "the reviewer needs to see the entire session history/
  // trajectory to analyze it... this is not our first session addressing it" —
  // generalizes the trade-approval fix into a configurable, per-bot dial rather
  // than one fixed shape. Mike also flagged the cost tradeoff directly, hence
  // this being a dial rather than always defaulting to the deepest tier.
  //   "initial" ("Sound | Initial Request")   — operatorRequest only. The
  //     narrowest, cheapest tier: no standing task, no last message, no
  //     transcript. Closest to the reviewer's original pre-CLAW-103 shape.
  //   "recent"  ("Sound | Recent Conversation") — operatorRequest +
  //     standingRequest + lastAssistantMessage (CLAW-103 + 2026-08-24's
  //     consent-context fix). DEFAULT — the shape already shipped fleet-wide
  //     today; choosing it here means introducing this dial changes nobody's
  //     behavior or cost until a bot is explicitly moved to a different tier.
  //   "full"    ("Sound | Full Trajectory") — the WHOLE session transcript
  //     (or its most recent portion if it exceeds contextMaxChars), read via
  //     transcript.ts. Deepest and most expensive: a real disk read+parse
  //     plus materially more judge-prompt tokens on every L2-eligible call.
  // Unrecognized values fall back to "recent" (fail toward the shipped
  // default, not toward the cheapest or the most expensive tier).
  const contextDepthRaw = (process.env.OASIS_REVIEWER_CONTEXT_DEPTH ?? "recent").toLowerCase();
  const contextDepth: "initial" | "recent" | "full" =
    contextDepthRaw === "initial" || contextDepthRaw === "full" ? contextDepthRaw : "recent";
  const contextMaxChars = Number(process.env.OASIS_REVIEWER_CONTEXT_MAX_CHARS ?? "20000") || 20_000;
  // Resolved once at register, same pattern as l2Complete above: prefer the
  // plugin runtime's own session.resolveSessionFilePath (the SAME resolution
  // logic openclaw core itself uses — sessionStore lookups, custom sessionFile
  // overrides, multi-store configs, all handled correctly), falling back to
  // transcript.ts's hand-built path only if that API is unavailable. Logged at
  // startup below so a version drift here is visible without guessing.
  const resolveSessionFilePath =
    typeof runtime?.session?.resolveSessionFilePath === "function"
      ? runtime.session.resolveSessionFilePath.bind(runtime.session)
      : undefined;
  if (contextDepth === "full" && !resolveSessionFilePath) {
    api.logger.info(
      "oasis-reviewer: context depth 'full' requested but runtime.session.resolveSessionFilePath is unavailable — using the fallback path convention instead (see transcript.ts)",
    );
  }

  // Capture the operator's ask for this run so the judge can evaluate intent, not
  // just mechanics. Read-only and defensive — a failure here must never disturb the
  // turn, it only costs the judge its context.
  api.on("llm_input", (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
    try {
      const runId = String(ctx?.runId ?? event?.runId ?? "");
      const sessionId = String(ctx?.sessionId ?? event?.sessionId ?? "");
      rememberRequest(runId, sessionId, String(event?.prompt ?? ""));
    } catch {
      /* never let request capture affect the run */
    }
  });

  api.on("before_tool_call", async (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
    let decision: Decision = { verdict: "allow", principle: "hard:default-allow", reason: "" };
    let toolName = "unknown";
    let needsConstitution = false;
    try {
      toolName = String(event.toolName ?? "unknown");
      const toolKind = event.toolKind as string | undefined;
      const toolInputKind = event.toolInputKind as string | undefined;
      const params = event.params as Record<string, unknown> | undefined;
      const derivedPaths = event.derivedPaths as readonly string[] | undefined;
      const family = classifyTool(toolName, toolKind, toolInputKind);

      // ── Layer 1: hard constraints (per-bot) ──
      decision = evaluateHard({ family, toolName, params, derivedPaths }, hardPolicy);

      // ── Layer 2: constitution (model-judged) ──
      // Runs on the ambiguous middle (Layer 1 allowed) — and ALWAYS for bots
      // flagged constitutionalReviewRequired (nimbus/helloworld: judge every ask
      // for secret-malicious use of google data). Layer 2 may only TIGHTEN.
      needsConstitution = constitution.length > 0 && (decision.verdict === "allow" || alwaysConstitutional);

      const subject = subjectOf(family, params, derivedPaths);
      const paramsJson = safeJson(params);
      const sessionId = ctx?.sessionId ?? "unknown";
      const sessionKey = String(ctx?.sessionKey ?? "");
      const unattended = isUnattended(sessionKey);
      // What Mike asked for this run — the judge's evidence for intent.
      const operatorRequest = requestByRun.get(String(ctx?.runId ?? "")) ?? "";
      // CLAW-103: the standing task from earlier in this session, sent ALONGSIDE
      // the per-run request (never instead of it) so a call made after a failed
      // or garbled turn is still judged against the work it actually serves.
      // Read via sessionId, which survives the run boundary that runId does not.
      const standingRequest = standingBySession.get(String(sessionId)) ?? "";
      // 2026-08-24: the bot's own last message, so a short operator reply
      // ("go for it", "yes") can be matched to whatever it was confirming —
      // see the block comment above lastAssistantMessageBySession.
      const lastAssistantMessage = lastAssistantMessageBySession.get(String(sessionId)) ?? "";

      // ── Which calls are worth a model judgment ──
      // constitutionalReviewRequired bots (nimbus/helloworld) → EVERY call: their
      // whole point is judging intent around Mike's Google data, and a read is
      // exactly how exfil starts. Everyone else → the acting families (exec, file
      // writes, web). Pure reads on those bots stay unjudged: L1 already denies
      // secret reads, and a model call per `ls` is latency and spend for little
      // signal. Set OASIS_REVIEWER_L2_ALL=1 to judge every call on every bot.
      const isWriteLike =
        family === "file" &&
        (/write|edit|patch|create|append|mkdir|mv|cp|rm|delete|tee/i.test(toolName) ||
          (!!params && ("content" in params || "text" in params)));
      const l2Worthwhile = l2All || alwaysConstitutional || family === "exec" || isWriteLike || family === "web";
      const l2Eligible = needsConstitution && l2Worthwhile && !!l2Complete && l2Mode !== "off";

      // ── Context depth (2026-08-24) — apply the configured tier ──
      // Only pays the transcript-read cost when the call will actually reach
      // Layer 2 (l2Eligible) — reading+parsing a session file for a call that
      // was never going to be judged is pure waste. "initial" clears the
      // deeper fields down to operatorRequest alone; "full" tries to read the
      // whole session and, on ANY failure (missing file, empty transcript,
      // resolveSessionFilePath throwing), silently keeps the "recent" fields
      // already computed above rather than judging with no context at all —
      // see the module comment on contextDepth.
      let effectiveStandingRequest = standingRequest;
      let effectiveLastAssistantMessage = lastAssistantMessage;
      let sessionTranscript = "";
      let sessionTranscriptTruncated = false;
      if (contextDepth === "initial") {
        effectiveStandingRequest = "";
        effectiveLastAssistantMessage = "";
      } else if (contextDepth === "full" && l2Eligible) {
        const sid = String(sessionId ?? "");
        if (sid && sid !== "unknown") {
          try {
            const agentIdForPath = String(ctx?.agentId ?? "main");
            const filePath = resolveSessionFilePath
              ? resolveSessionFilePath(sid, undefined, { agentId: agentIdForPath })
              : fallbackSessionFilePath(sid, agentIdForPath);
            const summary = readSessionTranscriptSummary(filePath, contextMaxChars);
            if (summary.text) {
              sessionTranscript = summary.text;
              sessionTranscriptTruncated = summary.truncated;
              // The transcript already contains both — no need to duplicate.
              effectiveStandingRequest = "";
              effectiveLastAssistantMessage = "";
            }
          } catch {
            /* degrade to the "recent" fields already computed above */
          }
        }
      }

      // report_injection's independent review (see the dispatch block near the end of
      // this hook, and formatInjectionReviewAlert above). Computed here, ahead of the
      // main audit write below, purely so that row can record whether a follow-up
      // phase:"injection_review" row should be expected — it does not affect `decision`
      // and is not part of Layer 1/Layer 2 at all.
      const injectionReviewEligible = toolName === "report_injection" && injectionReviewMode !== "off" && !!l2Complete;

      let l2Row: Record<string, unknown> | null = null;

      // ── Layer 2 ENFORCE: await the judgment and let it tighten ──
      // Blocking on purpose. A verdict that lands after the tool ran is an audit
      // note, not a control, so enforcement has to pay the latency (~2s measured).
      // The concurrency cap deliberately does NOT apply here: skipping a judgment
      // under load would silently drop governance instead of applying it. Parallel
      // fan-out is bounded anyway — an agent issues its tool calls one at a time,
      // so concurrency tracks the number of simultaneously-active turns.
      if (l2Eligible && l2Mode === "enforce") {
        const l1 = decision;
        const r = await judgeConstitution(
          l2Complete as LlmComplete,
          {
            botKey,
            toolName,
            family,
            subject,
            params: paramsJson,
            constitution,
            operatorRequest,
            standingRequest: effectiveStandingRequest,
            lastAssistantMessage: effectiveLastAssistantMessage,
            sessionTranscript: sessionTranscript || undefined,
            sessionTranscriptTruncated,
          },
          { model: l2Model, timeoutMs: l2TimeoutMs, thinkingLevel: l2Thinking, maxTokens: l2MaxTokens },
        );
        // ── Operator-consent downgrade (CLAW-079) — deliberately narrow ──
        // Layer 2 is tighten-only by design, so a manipulated judge can never talk
        // Layer 1 down. The one exception: rules the POLICY AUTHOR marked as
        // satisfiable by consent (CONSENT_SATISFIABLE — currently just cron
        // authoring). Those exist to make Mike approve an action, so if he already
        // asked for it this run and the judge — now able to see the request —
        // agrees, a second approval is pure friction. Requires all three: a
        // consent-satisfiable principle, a captured request, and an explicit L2
        // allow. Denies, self-runtime, and every other escalate stay untouchable.
        const consentDowngrade =
          l1.verdict === "escalate" &&
          CONSENT_SATISFIABLE.has(l1.principle) &&
          !!operatorRequest &&
          r.decision?.verdict === "allow";
        const combined = consentDowngrade
          ? {
              verdict: "allow" as const,
              principle: `${l1.principle}+operator-consent`,
              reason: `${r.decision?.reason ?? "constitution allowed"} — Mike requested this in the same run, so the authoring approval is already given`,
            }
          : r.decision
            ? tightenOnly(l1, r.decision)
            : null;
        // ── INERT-READ BACKSTOP (CLAW-090) ──
        // Layer 2 may tighten, but ESCALATING A READ is never the right
        // tightening. A read the judge believes is malicious should be DENIED
        // (that path is untouched below); one it does not believe is malicious
        // is just friction, because "may the bot run `git status`?" is not a
        // question Mike can usefully answer.
        //
        // Measured cost of not having this (House, 2026-08-10): 29 Layer 2
        // escalations in one session, ALL of them l2Tightened — Layer 1 had
        // allowed every single one — and NONE of which mutated a repo or placed
        // an order. 18 were read-only git (status/diff/log/grep/rev-parse), and
        // the judge kept re-raising them because each retry is a fresh 180s
        // prompt. The session ended in "Agent couldn't generate a response".
        //
        // Narrow by construction. It fires only when ALL of these hold:
        //   1. Layer 1 itself allowed the call (never rescues an L1 escalate),
        //   2. EITHER the family is exec and EVERY pipeline stage is a provably
        //      side-effect-free argv tool, a read-only git subcommand, or a
        //      read-only docker/aws multiplexer subcommand
        //      (isInertReadOnlyPipelineForL2Backstop), OR the call is one of
        //      the native read-only tools (read/fs_grep/fs_glob/fs_help/ls/
        //      memory_search — isInertReadOnlyToolCall),
        //   3. the combined verdict is escalate, not deny.
        // The prose fix to the constitution is the primary repair; this is the
        // backstop for the judge re-reading it too broadly, which has now
        // happened twice on exec/git calls and is a structurally identical
        // risk on a plain `read`/`fs_grep`/etc. call for any bot flagged to
        // require Layer 2 review on every call — a wrongly-escalated read had
        // no backstop until this widening, 2026-08-16.
        //
        // WIDENED 2026-08-16 to close two gaps found while investigating the
        // git incident above: (a) the exec-side check only recognized git as a
        // multiplexer, so `docker ps`/`docker logs`/`docker inspect` and
        // `aws … describe-*`/`list-*` — enumerated read-only subcommands the
        // constitution's own ESCALATION HYGIENE principle already says to
        // judge "by SUBCOMMAND, never by the presence of the program's name" —
        // had no mechanical backstop, only that prose; (b) the check was
        // exec-only, so a native (non-shell) read tool call could never be
        // rescued at all, on any bot, regardless of family. See policy.ts's
        // isInertDockerStage/isInertAwsStage/isInertReadOnlyToolCall for the
        // exact enumerated sets and the reasoning for what was deliberately
        // left OUT (aws `get-*`, `gh`, docker `rm`/`stop`/`kill`, etc. — all
        // still fully escalatable).
        const inertRead =
          (family === "exec" && isInertReadOnlyPipelineForL2Backstop(execCommandOf(params))) ||
          isInertReadOnlyToolCall(toolName);
        const inertReadKept = !!combined && combined.verdict === "escalate" && l1.verdict === "allow" && inertRead;
        if (inertReadKept) {
          decision = l1;
        } else if (combined) {
          decision = combined;
        } else if (alwaysConstitutional) {
          // No verdict (timeout / unreachable model / unparseable JSON) on a bot
          // whose constitution is MANDATORY. Falling back to L1 here would recreate
          // exactly the "constitutionalReviewRequired has no teeth" gap, so this
          // fails CLOSED instead.
          decision = {
            verdict: "deny",
            principle: "l2:unavailable-fail-closed",
            reason: `constitution could not be evaluated (${r.error ?? "unparseable verdict"}) and is mandatory for ${botKey}`,
          };
        }
        // Other bots: keep the L1 verdict (L1 is still a real gate) — recorded below.
        l2Row = {
          l2Verdict: r.decision?.verdict ?? null,
          l2Principle: r.decision?.principle ?? null,
          l2Reason: r.decision?.reason ?? null,
          l2AgreesWithL1: r.decision ? r.decision.verdict === l1.verdict : null,
          l2Ms: r.ms,
          l2ParseFail: r.decision ? undefined : (r.raw || null),
          l2Error: r.error ?? null,
          l2Tightened: !!combined && !inertReadKept && combined.verdict !== l1.verdict,
          // Records every escalate-on-an-inert-read the backstop absorbed, so
          // the constitution's own drift stays measurable after the prose fix.
          l2InertReadKept: inertReadKept || undefined,
          l2FailClosed: !r.decision && alwaysConstitutional,
          l2RetryHint: r.decision?.retryHint ?? null,
        };
      }

      // ── Unattended adjustment (CLAW-078) ──
      // Applied to the COMBINED L1+L2 verdict, so an escalate the constitution
      // raised is handled the same way as one L1 raised. Denies are untouched: an
      // unattended run gets no free pass on destructive/exfil/control-plane. Only
      // escalations move, because unattended they are unanswerable.
      let downgraded = false;
      if (unattended && decision.verdict === "escalate") {
        if (NEVER_DOWNGRADE.has(decision.principle)) {
          decision = {
            verdict: "deny",
            principle: decision.principle,
            reason: `${decision.reason} — no approver in an unattended run (${sessionKey}); failing closed`,
          };
        } else {
          downgraded = true;
          decision = {
            verdict: "allow",
            principle: `${decision.principle}+unattended-downgrade`,
            reason: `${decision.reason} — allowed unattended (${sessionKey}); consent was given when the job was authored`,
          };
        }
      }

      write({
        ...(l2Row ?? {}),
        ts: new Date().toISOString(),
        phase: "before_tool_call",
        mode,
        bot: botKey,
        sessionId,
        // sessionKey is the trigger fingerprint (cron:<jobId>, hook:<uuid>, or a
        // channel session key). Recorded on EVERY row so the unattended-prefix list
        // stays evidence-based — this is how we find the heartbeat/sessionTarget
        // keys that prefix-matching misses today.
        sessionKey: sessionKey || null,
        unattended,
        downgraded,
        agentId: ctx?.agentId ?? null,
        toolCallId: event.toolCallId ?? null,
        toolName,
        family,
        subject,
        derivedPaths: derivedPaths ?? null,
        params: paramsJson,
        verdict: decision.verdict,
        principle: decision.principle,
        reason: decision.reason,
        // 2026-08-24: the safer-retry suggestion surfaced to the agent/Mike
        // alongside the reason, when one exists — see Decision.retryHint.
        retryHint: decision.retryHint ?? null,
        l2Mode,
        l2Judged: l2Eligible,
        // 2026-08-24: the configured context tier ("initial"|"recent"|"full")
        // and what it actually produced for THIS call — see the contextDepth
        // block comment above. The had* fields below reflect what was
        // actually SENT to the judge (post context-depth filtering /
        // fallback), not just what was captured, so they are the ground
        // truth for "did the fix actually fire" rather than an intent proxy.
        contextDepth,
        hadOperatorRequest: !!operatorRequest,
        // CLAW-103: true when a standing task from an EARLIER run in this session
        // was carried into the judgment. Grep for rows where this is true and
        // hadOperatorRequest is false — that is exactly the failure shape the fix
        // targets (a run whose own prompt was a fragment), so it is the cheapest
        // way to confirm the fix fires in production rather than assuming it does.
        hadStandingRequest: !!effectiveStandingRequest && effectiveStandingRequest !== operatorRequest,
        // 2026-08-24: true when the bot's own last message was available to
        // feed the judge — see lastAssistantMessageBySession above. Grep for
        // rows where this is true and l2Tightened is false on a call whose
        // operatorRequest is short — that is the shape this fix targets.
        hadLastAssistantMessage: !!effectiveLastAssistantMessage,
        // "Sound | Full Trajectory" — true only when contextDepth is "full"
        // AND the transcript read actually produced content (a failed read
        // silently falls back to the "recent" fields above, so this can be
        // false even in full mode — see the contextDepth block comment).
        hadSessionTranscript: !!sessionTranscript,
        sessionTranscriptTruncated: sessionTranscript ? sessionTranscriptTruncated : null,
        layer2Pending: l2Eligible && l2Mode === "shadow",
        // See the injection-review dispatch block below: when true, a separate
        // phase:"injection_review" row for this same toolCallId follows once the
        // model judgment lands (async, never blocks this row or the tool call).
        injectionReviewPending: injectionReviewEligible,
        enforced: mode === "enforce" && decision.verdict !== "allow",
      });

      // ── Layer 2 SHADOW: fire-and-forget ──
      // Non-blocking: the hook returns the Layer 1 verdict immediately and the model
      // judgment lands later as a separate `phase:"layer2"` row, recording what the
      // constitution WOULD have said. Concurrency-capped, because in shadow a
      // dropped judgment costs only a log line.
      if (l2Eligible && l2Mode === "shadow" && l2InFlight < L2_MAX_INFLIGHT) {
        l2InFlight++;
        const l1Verdict = decision.verdict;
        const l1Principle = decision.principle;
        void judgeConstitution(
          l2Complete as LlmComplete,
          {
            botKey,
            toolName,
            family,
            subject,
            params: paramsJson,
            constitution,
            operatorRequest,
            standingRequest: effectiveStandingRequest,
            lastAssistantMessage: effectiveLastAssistantMessage,
            sessionTranscript: sessionTranscript || undefined,
            sessionTranscriptTruncated,
          },
          // No agentId: passing it is treated as a target-agent OVERRIDE and
          // rejected ("Plugin LLM completion cannot override the target agent").
          // Omitting it uses the ambient agent's own model/credentials.
          { model: l2Model, timeoutMs: l2TimeoutMs, thinkingLevel: l2Thinking, maxTokens: l2MaxTokens },
        )
          .then((r) => {
            write({
              ts: new Date().toISOString(),
              phase: "layer2",
              l2Mode,
              bot: botKey,
              sessionId,
              toolName,
              family,
              subject,
              l1Verdict,
              l1Principle,
              l2Verdict: r.decision?.verdict ?? null,
              l2Principle: r.decision?.principle ?? null,
              l2Reason: r.decision?.reason ?? null,
              l2AgreesWithL1: r.decision ? r.decision.verdict === l1Verdict : null,
              l2Ms: r.ms,
              l2ParseFail: r.decision ? undefined : (r.raw || null),
              l2Error: r.error ?? null,
              l2RetryHint: r.decision?.retryHint ?? null,
              contextDepth,
              hadSessionTranscript: !!sessionTranscript,
              enforced: false, // shadow: L2 never changes the decision yet
            });
          })
          .finally(() => {
            l2InFlight--;
          });
      }

      // ── report_injection independent review (2026-08-14, House + Kolmogorov) ──
      // report_injection is the agent's OWN self-report tool — deliberately low-bar
      // ("always report — false positives are welcome",
      // prompt-injection-reporting/src/tools/report-injection.ts). Its log + Telegram
      // alert must keep firing unconditionally (Mike wants the false-positive data,
      // not silent failures — see attack-logger.ts, entirely untouched by this block).
      // So this block NEVER reads or writes `decision` and NEVER awaits before
      // returning from the hook — it cannot block, delay, or alter the report_injection
      // call in any way, in either shadow or enforce mode. What it adds: the
      // reviewer's OWN independent read on whether the flagged content really looks
      // like an injection, using the SAME operatorRequest evidence that already
      // correctly cleared Kolmogorov's deep_search follow-up call three minutes after
      // its report_injection false positive (2026-08-14 incident).
      if (injectionReviewEligible) {
        const ra = (params ?? {}) as { incident_type?: string; detail?: string; suspicious_content?: string };
        const reviewInput: InjectionReviewInput = {
          botKey,
          incidentType: String(ra.incident_type ?? "other"),
          // Same caps report-injection.ts itself applies before writing the attack
          // log — bounds judge cost/latency and keeps this consistent with what the
          // agent's own report actually persists.
          detail: String(ra.detail ?? "").slice(0, 2000),
          suspiciousContent: String(ra.suspicious_content ?? "").slice(0, 1000),
          operatorRequest,
        };
        const toolCallIdForReview = event.toolCallId ?? null;
        void judgeInjectionReport(l2Complete as LlmComplete, reviewInput, {
          model: l2Model,
          timeoutMs: l2TimeoutMs,
          thinkingLevel: l2Thinking,
          maxTokens: l2MaxTokens,
        }).then(async (r) => {
          write({
            ts: new Date().toISOString(),
            phase: "injection_review",
            injectionReviewMode,
            bot: botKey,
            sessionId,
            sessionKey: sessionKey || null,
            toolCallId: toolCallIdForReview,
            incidentType: reviewInput.incidentType,
            hadOperatorRequest: !!operatorRequest,
            reviewerVerdict: r.decision?.verdict ?? null,
            // Quick-grep boolean: does the reviewer's independent read agree with the
            // agent's own self-report (which is implicitly "yes, suspicious" by
            // virtue of having called report_injection at all)?
            reviewerAgreesWithSelfReport:
              r.decision?.verdict === "confirmed" ? true : r.decision?.verdict === "unconfirmed" ? false : null,
            reviewerReason: r.decision?.reason ?? null,
            reviewerParseFail: r.decision ? undefined : (r.raw || null),
            reviewerError: r.error ?? null,
            ms: r.ms,
            // This feature never gates report_injection, so `enforced` (used
            // elsewhere in this file to mean "the reviewer's verdict changed what
            // happened") does not apply here. "enforce" for this feature means "also
            // send the reviewer's own Telegram alert" — recorded below.
            alerted: injectionReviewMode === "enforce" && !!r.decision,
          });
          if (injectionReviewMode === "enforce" && r.decision && telegramBotToken && telegramChatId) {
            try {
              await sendTelegramMessage({
                botToken: telegramBotToken,
                chatId: telegramChatId,
                text: formatInjectionReviewAlert(botKey, reviewInput.incidentType, r.decision),
                parseMode: "Markdown",
              });
            } catch (err) {
              api.logger.info("oasis-reviewer: injection-review Telegram alert failed", {
                error: String((err as Error)?.message ?? err),
              });
            }
          }
        });
      }
    } catch (err) {
      write({ ts: new Date().toISOString(), phase: "before_tool_call", mode, bot: botKey, toolName, error: String((err as Error)?.message ?? err), enforced: mode === "enforce" });
      // CLAW-073 FAIL-CLOSE: a reviewer that cannot form a verdict must not wave the
      // call through. In ENFORCE this now DENIES the erroring call (matching the
      // design's stated fail-closed posture — openclaw's hook-runner is fail-closed,
      // but our own try/catch used to swallow that into an allow). Kept mode-aware:
      // SHADOW bots still observe-only (never block), so a reviewer bug can brick
      // neither a shadow bot nor the fleet — only the single erroring call on an
      // already-enforcing bot is denied. Degrade-safe, not brick.
      if (mode === "enforce") return { block: true, blockReason: "reviewer: internal error (fail-closed)" };
      return;
    }

    if (mode !== "enforce") return; // shadow: log only

    // 2026-08-24: surface the retry hint (if any) alongside the reason, so the
    // agent reading a deny — or Mike reading an escalate — has something
    // actionable besides "no". See Decision.retryHint / Layer2Decision.retryHint.
    if (decision.verdict === "deny") {
      const retrySuffix = decision.retryHint ? ` — safer retry: ${decision.retryHint}` : "";
      return { block: true, blockReason: `reviewer: ${decision.reason}${retrySuffix}` };
    }
    if (decision.verdict === "escalate") {
      const retrySuffix = decision.retryHint
        ? `\nIf you'd rather retry now instead of waiting on approval: ${decision.retryHint}`
        : "";
      return {
        requireApproval: {
          title: "Reviewer approval required",
          description: `${decision.reason}\n(rule: ${decision.principle}, bot: ${botKey}, tool: ${toolName})${retrySuffix}`,
          severity: "warning" as const,
          // 10 min (= MAX_PLUGIN_APPROVAL_TIMEOUT_MS, the runtime ceiling): the
          // operator copy-pastes `/approve <id> <decision>` from a Telegram DM,
          // often from a phone. 90s was too tight, and so was the 180s that
          // replaced it — on 2026-08-20 House logged 8 waits pinned at ~179.98s
          // (the ceiling) against ~12 that landed, i.e. roughly 40% of approval
          // requests died as "exec failed: Approval timed out" and broke the
          // agent's task mid-flight. Raising the window costs nothing when Mike
          // answers promptly (the wait ends on his reply, not on the timeout).
          // This CANNOT hang an unattended run: the unattended adjustment above
          // resolves every escalate to allow/deny before this path is reached,
          // so requireApproval is only ever issued in an attended session.
          // Security posture is unchanged — timeoutBehavior stays "deny".
          timeoutMs: 600_000,
          timeoutBehavior: "deny" as const,
          allowedDecisions: ["allow-once", "allow-always", "deny"] as const,
        },
      };
    }
    // allow — Layer 2 (constitution) would refine this once the model call lands.
    return;
  });

  // ── before_agent_finalize hook: last-message capture + loop guard ──
  // Fires once per turn, right before the agent's reply would be sent/finalized.
  // ALWAYS registered (2026-08-24): the last-assistant-message capture that
  // before_tool_call's Layer 2 judgment now depends on (see
  // lastAssistantMessageBySession above) must run on every bot, not only ones
  // with the loop guard turned on — the two features happen to share this one
  // event but are otherwise unrelated. The loop-guard body below is unchanged
  // and still gated on loopGuardMode, same as before.
  const loopGuardMode = (process.env.OASIS_REVIEWER_LOOP_GUARD ?? "off").toLowerCase();
  const loopGuardThreshold = Number(process.env.OASIS_REVIEWER_LOOP_GUARD_THRESHOLD ?? "3") || 3;
  api.on("before_agent_finalize", (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
    // Capture first, unconditionally. Own try/catch, never returns a value —
    // a bug here must never suppress or alter the loop guard below.
    try {
      const sessionId = String(ctx?.sessionId ?? event?.sessionId ?? "");
      rememberLastAssistantMessage(sessionId, String(event?.lastAssistantMessage ?? ""));
    } catch {
      /* never let capture affect the turn */
    }

    if (loopGuardMode === "off") return; // capture-only: no loop guard configured

    try {
      const sessionId = String(event?.sessionId ?? ctx?.sessionId ?? "unknown");
      const text = String(event?.lastAssistantMessage ?? "");
      if (!text.trim()) return;

      const hash = hashForLoopGuard(text);
      const prior = loopGuardHistory.get(sessionId);
      const streak = prior && prior.hash === hash ? prior.streak + 1 : 1;

      if (!loopGuardHistory.has(sessionId) && loopGuardHistory.size >= LOOP_GUARD_HISTORY_MAX) {
        const oldest = loopGuardHistory.keys().next().value;
        if (oldest !== undefined) loopGuardHistory.delete(oldest);
      }
      loopGuardHistory.set(sessionId, { hash, streak });

      if (streak < loopGuardThreshold) return;

      write({
        ts: new Date().toISOString(),
        phase: "loop_guard",
        loopGuardMode,
        bot: botKey,
        sessionId,
        streak,
        threshold: loopGuardThreshold,
        textPreview: text.slice(0, 200),
        enforced: loopGuardMode === "enforce",
      });

      if (loopGuardMode !== "enforce") return; // shadow: log only, never act

      // Reset so we don't force-finalize every subsequent turn too — only the
      // turn that crosses the threshold gets stopped.
      loopGuardHistory.delete(sessionId);
      return {
        action: "finalize" as const,
        reason: `oasis-reviewer loop guard: the same reply repeated ${streak} times in a row for this session — forcing this turn to end instead of continuing the loop.`,
      };
    } catch (err) {
      write({
        ts: new Date().toISOString(),
        phase: "loop_guard",
        loopGuardMode,
        bot: botKey,
        error: String((err as Error)?.message ?? err),
      });
      return; // never block finalize on a bug in this guard itself
    }
  });

  api.logger.info(`oasis-reviewer: Layer 1 active (mode=${mode}, bot=${botKey})`, {
    auditFile,
    policyLoaded: !!policy,
    constitutionPrinciples: constitution.length,
    alwaysConstitutional,
    allowWriteRoots: hardPolicy.allowWriteRoots,
    layer2: l2Complete
      ? `${l2Mode} (model=${l2Model ?? "agent-default"}, timeout=${l2TimeoutMs}ms, scope=${l2All ? "all-calls" : alwaysConstitutional ? "all-calls(constitutional-bot)" : "exec+write+web"})`
      : "off",
    // 2026-08-24: "Sound | Initial Request" | "Sound | Recent Conversation" |
    // "Sound | Full Trajectory" — see the contextDepth block comment above.
    contextDepth: `${contextDepth} (maxChars=${contextMaxChars}, sessionFilePathSource=${resolveSessionFilePath ? "runtime" : "fallback"})`,
    loopGuard: loopGuardMode === "off" ? "off" : `${loopGuardMode} (threshold=${loopGuardThreshold})`,
    injectionReview:
      injectionReviewMode === "off"
        ? "off"
        : `${injectionReviewMode} (telegram=${telegramBotToken && telegramChatId ? "configured" : "not-configured"})`,
  });
}
