/**
 * context-nap — the CONTEXT-THRESHOLD deep-sleep trigger (CLAW efficiency track).
 *
 * The nightly `sleep_deep` cron and the native daily reset both fire on the
 * CLOCK. This adds the missing axis: fire the same archive+reset+waking-summary
 * cycle when a session's live prompt crosses a fraction of the ACTIVE model's
 * context window — "attention exhausted", take a power nap.
 *
 * Continuity is NEVER lost, only the working window is refreshed: the archived
 * transcript stays on disk in full, the handoff tail + vector-ranked memories
 * seed the fresh session (via the waking supplement), and the agent can re-read
 * any prior detail on demand. The goal is cost-efficient continuity of
 * knowledge and competence, not amnesia.
 *
 * Why a fraction of the budget and not a fixed token count: `contextTokenBudget`
 * is per-MODEL, so a single ratio auto-scales — a 32K fallback model (gemma)
 * naps ~6x sooner than a 200K primary (sonnet) for the same work. The "smaller
 * brain needs more rest" behavior falls out for free.
 *
 * Relationship to native compaction: openclaw auto-compacts at
 * `budget - reserveTokensFloor - softThreshold` (with our 5K reserve floor:
 * `budget - 9000`). The nap MUST fire first, or we'd pay a summarization/handoff
 * compaction on the weak model instead of a free reset. So the trigger is
 *   napTokens = min(thresholdRatio * budget, (budget - preemptTokens) - guardTokens)
 * — the ratio governs on big models; the pre-empt term guarantees we beat
 * compaction on small ones. Native compaction stays as the ceiling safety-net
 * for any session a nap doesn't cover (e.g. a non-matching ephemeral session,
 * or if the gateway lacks scope to reset).
 *
 * openclaw's plugin runtime runs no background timer (verified 2026-07-13), so
 * this is driven entirely off per-turn hooks: `llm_output` carries usage +
 * per-model `contextTokenBudget`; `message_sending` shares the same `runId` /
 * `sessionKey` (documented equality) so the notice rides that turn's outbound;
 * the reset runs at `agent_end`, a clean turn boundary after delivery.
 */

export type ContextNapConfig = {
  enabled: boolean;
  /** Fraction (0..1) of the model's context budget that triggers a nap. */
  thresholdRatio: number;
  /**
   * Tokens reserved below the window before native compaction fires — keep in
   * sync with `agents.defaults.compaction.reserveTokensFloor + softThreshold`
   * (our entrypoint: 5000 + 4000 = 9000). The nap fires before this line.
   */
  preemptTokens: number;
  /** Fire the nap this many tokens BEFORE the native compaction line. */
  guardTokens: number;
  /** Never nap while the prompt is smaller than this (avoids tiny-budget noise). */
  minAbsoluteTokens: number;
  /** Per-session debounce so a pinned-high context can't nap every turn. */
  minMsBetweenNaps: number;
  /** Operator-visible notice appended to the tripping turn's reply. */
  message: string;
  /** Substring filters selecting which session keys are nap-eligible. */
  sessionMatch: string[];
};

export type NapUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

/** Prompt-side token count seen by the model this call (excludes output). */
export function promptTokensFromUsage(usage: NapUsage | undefined): number {
  if (!usage) return 0;
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

export type NapDecision = {
  nap: boolean;
  napTokens: number;
  promptTokens: number;
  ratio: number;
  reason: "ratio" | "preempt-compaction" | "under-threshold" | "below-floor" | "no-budget";
};

/** Pure trigger math — no IO, fully unit-tested. */
export function computeNapDecision(args: {
  promptTokens: number;
  contextTokenBudget: number | undefined;
  cfg: Pick<
    ContextNapConfig,
    "thresholdRatio" | "preemptTokens" | "guardTokens" | "minAbsoluteTokens"
  >;
}): NapDecision {
  const { promptTokens } = args;
  const budget = args.contextTokenBudget;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
    return { nap: false, napTokens: Infinity, promptTokens, ratio: 0, reason: "no-budget" };
  }
  const ratioTrigger = args.cfg.thresholdRatio * budget;
  const preemptTrigger = budget - args.cfg.preemptTokens - args.cfg.guardTokens;
  const napTokens = Math.max(0, Math.min(ratioTrigger, preemptTrigger));
  const ratio = promptTokens / budget;
  if (promptTokens < args.cfg.minAbsoluteTokens) {
    return { nap: false, napTokens, promptTokens, ratio, reason: "below-floor" };
  }
  const nap = promptTokens >= napTokens;
  if (!nap) {
    return { nap, napTokens, promptTokens, ratio, reason: "under-threshold" };
  }
  // Which term bound the trigger — informational, for the log line.
  return {
    nap,
    napTokens,
    promptTokens,
    ratio,
    reason: ratioTrigger <= preemptTrigger ? "ratio" : "preempt-compaction",
  };
}

export type ContextNapDeps = {
  cfg: ContextNapConfig;
  /** Perform the actual archive+reset+waking-summary for one session key. */
  runNap: (sessionKey: string) => Promise<void>;
  nowMs: () => number;
  log?: (msg: string) => void;
};

type PendingNap = { sessionKey: string; announced: boolean; armedAtMs: number };

const MAX_PENDING = 128;

/**
 * Build the three per-turn hook handlers. State (pending naps + per-session
 * debounce) lives in this closure — in-memory is correct: a gateway restart
 * starts every session fresh anyway.
 */
export function createContextNapHooks(deps: ContextNapDeps) {
  const cfg = deps.cfg;
  const log = deps.log ?? (() => {});
  const pending = new Map<string, PendingNap>(); // keyed by runId
  const lastNapMsByKey = new Map<string, number>();

  const matches = (key: unknown): key is string =>
    typeof key === "string" && cfg.sessionMatch.some((m) => key.includes(m));

  const evictIfFull = () => {
    if (pending.size <= MAX_PENDING) return;
    // Drop the oldest armed entry — a runId whose agent_end we somehow missed.
    let oldestKey: string | undefined;
    let oldest = Infinity;
    for (const [k, v] of pending) {
      if (v.armedAtMs < oldest) {
        oldest = v.armedAtMs;
        oldestKey = k;
      }
    }
    if (oldestKey) pending.delete(oldestKey);
  };

  /** `llm_output`: decide whether this turn should nap; arm it by runId. */
  function onLlmOutput(event: any, ctx: any): void {
    if (!cfg.enabled) return;
    const sessionKey = ctx?.sessionKey;
    const runId = ctx?.runId ?? event?.runId;
    if (!matches(sessionKey) || typeof runId !== "string") return;
    if (pending.has(runId)) return; // already armed this turn
    const last = lastNapMsByKey.get(sessionKey) ?? 0;
    if (deps.nowMs() - last < cfg.minMsBetweenNaps) return;

    const budget = ctx?.contextTokenBudget ?? event?.contextTokenBudget;
    const promptTokens = promptTokensFromUsage(event?.usage as NapUsage | undefined);
    const d = computeNapDecision({ promptTokens, contextTokenBudget: budget, cfg });
    if (!d.nap) return;

    pending.set(runId, { sessionKey, announced: false, armedAtMs: deps.nowMs() });
    evictIfFull();
    log(
      `context-nap armed: session=${sessionKey} prompt=${promptTokens} budget=${budget} ` +
        `ratio=${d.ratio.toFixed(2)} napAt=${Math.round(d.napTokens)} reason=${d.reason}`,
    );
  }

  /**
   * `message_sending`: append the power-nap notice to the tripping turn's
   * outgoing reply (once). Channel-agnostic — replaces `content`.
   */
  function onMessageSending(event: any, ctx: any): { content: string } | void {
    if (!cfg.enabled) return;
    const runId = ctx?.runId;
    if (typeof runId !== "string") return;
    const p = pending.get(runId);
    if (!p || p.announced) return;
    p.announced = true;
    const content = typeof event?.content === "string" ? event.content : "";
    return { content: content ? `${content}\n\n${cfg.message}` : cfg.message };
  }

  /** `agent_end`: fire the reset at the clean turn boundary, after delivery. */
  async function onAgentEnd(event: any, ctx: any): Promise<void> {
    if (!cfg.enabled) return;
    const runId = ctx?.runId ?? event?.runId;
    if (typeof runId !== "string") return;
    const p = pending.get(runId);
    if (!p) return;
    pending.delete(runId);
    lastNapMsByKey.set(p.sessionKey, deps.nowMs());
    try {
      await deps.runNap(p.sessionKey);
      log(`context-nap fired: reset session=${p.sessionKey}`);
    } catch (err) {
      log(`context-nap reset failed (non-fatal): ${String(err)}`);
    }
  }

  return { onLlmOutput, onMessageSending, onAgentEnd };
}
