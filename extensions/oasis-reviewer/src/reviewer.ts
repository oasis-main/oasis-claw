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
  isInertReadOnlyPipeline,
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

function rememberRequest(runId: string, prompt: string): void {
  if (!runId || !prompt) return;
  // Keep the FIRST prompt of a run: that is the ask. Later ReAct steps re-enter
  // this hook and would otherwise overwrite it with intermediate state.
  if (requestByRun.has(runId)) return;
  if (requestByRun.size >= REQUEST_CACHE_MAX) {
    const oldest = requestByRun.keys().next().value;
    if (oldest !== undefined) requestByRun.delete(oldest);
  }
  requestByRun.set(runId, prompt.slice(0, REQUEST_MAX_CHARS));
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
  const runtime = (api as unknown as { runtime?: { llm?: { complete?: LlmComplete } } }).runtime;
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

  // Capture the operator's ask for this run so the judge can evaluate intent, not
  // just mechanics. Read-only and defensive — a failure here must never disturb the
  // turn, it only costs the judge its context.
  api.on("llm_input", (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
    try {
      const runId = String(ctx?.runId ?? event?.runId ?? "");
      rememberRequest(runId, String(event?.prompt ?? ""));
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
          { botKey, toolName, family, subject, params: paramsJson, constitution, operatorRequest },
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
        //   2. the family is exec,
        //   3. EVERY pipeline stage is a provably side-effect-free argv tool or
        //      a read-only git subcommand (isInertReadOnlyPipeline — the same
        //      function Layer 1 uses, so the layers cannot drift),
        //   4. the combined verdict is escalate, not deny.
        // The prose fix to the constitution is the primary repair; this is the
        // backstop for the judge re-reading it too broadly, which has now
        // happened twice.
        const inertRead = family === "exec" && isInertReadOnlyPipeline(execCommandOf(params));
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
        l2Mode,
        l2Judged: l2Eligible,
        hadOperatorRequest: !!operatorRequest,
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
          { botKey, toolName, family, subject, params: paramsJson, constitution, operatorRequest },
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

    if (decision.verdict === "deny") return { block: true, blockReason: `reviewer: ${decision.reason}` };
    if (decision.verdict === "escalate") {
      return {
        requireApproval: {
          title: "Reviewer approval required",
          description: `${decision.reason}\n(rule: ${decision.principle}, bot: ${botKey}, tool: ${toolName})`,
          severity: "warning" as const,
          // 3 min: the operator copy-pastes `/approve <id> <decision>` from the DM;
          // 90s was too tight (a late reply hit "unknown or expired approval id").
          // Unattended still fail-closes (timeoutBehavior:"deny").
          timeoutMs: 180_000,
          timeoutBehavior: "deny" as const,
          allowedDecisions: ["allow-once", "allow-always", "deny"] as const,
        },
      };
    }
    // allow — Layer 2 (constitution) would refine this once the model call lands.
    return;
  });

  // ── Loop guard hook ──
  // Independent of before_tool_call above: fires once per turn, right before
  // the agent's reply would be sent/finalized. Never throws past its own
  // try/catch — a bug here must degrade to "did nothing", the same fail-safe
  // posture as before_tool_call's shadow mode, not fail-closed like enforce's
  // deny-on-error (there is no useful "deny" for a reply that already exists).
  const loopGuardMode = (process.env.OASIS_REVIEWER_LOOP_GUARD ?? "off").toLowerCase();
  const loopGuardThreshold = Number(process.env.OASIS_REVIEWER_LOOP_GUARD_THRESHOLD ?? "3") || 3;
  if (loopGuardMode !== "off") {
    api.on("before_agent_finalize", (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
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
  }

  api.logger.info(`oasis-reviewer: Layer 1 active (mode=${mode}, bot=${botKey})`, {
    auditFile,
    policyLoaded: !!policy,
    constitutionPrinciples: constitution.length,
    alwaysConstitutional,
    allowWriteRoots: hardPolicy.allowWriteRoots,
    layer2: l2Complete
      ? `${l2Mode} (model=${l2Model ?? "agent-default"}, timeout=${l2TimeoutMs}ms, scope=${l2All ? "all-calls" : alwaysConstitutional ? "all-calls(constitutional-bot)" : "exec+write+web"})`
      : "off",
    loopGuard: loopGuardMode === "off" ? "off" : `${loopGuardMode} (threshold=${loopGuardThreshold})`,
    injectionReview:
      injectionReviewMode === "off"
        ? "off"
        : `${injectionReviewMode} (telegram=${telegramBotToken && telegramChatId ? "configured" : "not-configured"})`,
  });
}
