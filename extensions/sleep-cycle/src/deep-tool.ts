/**
 * sleep_deep — the deep-sleep agent tool.
 *
 * openclaw's plugin runtime does NOT run a plugin's background setInterval
 * (verified 2026-07-13), so the cycle is driven by openclaw's own cron: a
 * nightly light-context agentTurn (session: isolated, tools: [sleep_deep])
 * fires this tool. Tools DO execute reliably in the gateway process.
 *
 * What it does (idempotent, safe to call manually):
 *   1. list sessions, select the long-lived conversation session(s) by
 *      substring match (default "telegram:direct");
 *   2. capture a plain-text handoff tail from each transcript;
 *   3. sessions.reset each — openclaw renames the transcript to
 *      `<id>.jsonl.reset.<ts>` (the archive) and starts a fresh session, so
 *      the prompt-cache-eating growth resets (the whole point);
 *   4. vector-rank memory chunks for the morning (oasis-semantics, one embed
 *      burst, no LLM);
 *   5. write the waking summary into the sleep-cycle state file, which the
 *      memory-prompt supplement injects into the next session.
 */

import path from "node:path";
import type { GatewayCaller } from "./gateway-cli.js";
import { collectMemoryChunks, rankMemoryHits } from "./memory-rank.js";
import type { ArchivedSessionRef, MemoryHit } from "./mutex.js";
import { dateKeyInTimeZone } from "./schedule.js";
import type { StateStore } from "./state-store.js";
import { extractTail, findArchiveFor, sessionsDir } from "./transcripts.js";

export type SleepDeepConfig = {
  timezone: string;
  sessionMatch: string[];
  wakingSummary: {
    enabled: boolean;
    memoryHits: number;
    transcriptPointers: number;
    injectUntilHour: number;
  };
  semanticsEndpoint: string;
  semanticsModel: string;
};

type SessionListEntry = { key?: string; sessionId?: string };

function listedSessions(result: unknown): SessionListEntry[] {
  if (Array.isArray(result)) {
    return result as SessionListEntry[];
  }
  if (result && typeof result === "object" && Array.isArray((result as { sessions?: unknown[] }).sessions)) {
    return (result as { sessions: SessionListEntry[] }).sessions;
  }
  return [];
}

export function matchTargetSessions(
  entries: SessionListEntry[],
  sessionMatch: string[],
): SessionListEntry[] {
  return entries.filter((e) => e.key && sessionMatch.some((m) => e.key!.includes(m)));
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export type SleepDeepDeps = {
  cfg: SleepDeepConfig;
  homeDir: string;
  workspaceDir: string;
  call: GatewayCaller;
  store: StateStore;
  nowMs: () => number;
  log?: (msg: string) => void;
  /**
   * When set, reset exactly these session keys instead of the `sessionMatch`
   * filter. The context-nap trigger passes the single session that crossed the
   * threshold, so a nap never resets a different session than the one that
   * ballooned. Empty/undefined = fall back to `cfg.sessionMatch`.
   */
  overrideTargetKeys?: string[];
};

/** Core deep-sleep logic, separated from the tool wrapper for testing. */
export async function runDeepSleep(deps: SleepDeepDeps): Promise<{
  resetCount: number;
  memoryHitCount: number;
  archives: ArchivedSessionRef[];
}> {
  const { cfg, homeDir, workspaceDir, call, store } = deps;
  const log = deps.log ?? (() => {});
  const sessDir = sessionsDir(homeDir);

  let targets: SessionListEntry[] = [];
  try {
    const listed = listedSessions(await call("sessions.list", {}));
    const override = deps.overrideTargetKeys?.filter((k) => k) ?? [];
    targets =
      override.length > 0
        ? listed.filter((e) => e.key && override.includes(e.key))
        : matchTargetSessions(listed, cfg.sessionMatch);
  } catch (err) {
    log(`sessions.list failed: ${String(err)}`);
    return { resetCount: 0, memoryHitCount: 0, archives: [] };
  }

  const archives: ArchivedSessionRef[] = [];
  const handoffParts: string[] = [];
  for (const t of targets) {
    const key = t.key as string;
    const fileBase = t.sessionId ? `${t.sessionId}.jsonl` : undefined;
    const transcriptPath = fileBase ? path.join(sessDir, fileBase) : undefined;
    if (transcriptPath) {
      const tail = extractTail(transcriptPath);
      if (tail) {
        handoffParts.push(`### ${key}\n${tail}`);
      }
    }
    try {
      await call("sessions.reset", { key });
      archives.push({
        sessionKey: key,
        transcriptPath,
        archivePath: fileBase ? findArchiveFor(sessDir, fileBase.replace(/\.jsonl$/, "")) : undefined,
      });
      log(`reset ${key}`);
    } catch (err) {
      log(`sessions.reset ${key} failed: ${String(err)}`);
    }
  }

  const handoff = handoffParts.join("\n\n").slice(0, 4_000);
  let memoryHits: MemoryHit[] = [];
  if (cfg.wakingSummary.enabled && handoff) {
    memoryHits = await rankMemoryHits({
      endpoint: cfg.semanticsEndpoint,
      model: cfg.semanticsModel,
      query: handoff.slice(0, 1_500),
      chunks: collectMemoryChunks(workspaceDir),
      topK: cfg.wakingSummary.memoryHits,
    });
  }

  const dateKey = dateKeyInTimeZone(deps.nowMs(), cfg.timezone);
  store.save({
    ...store.state,
    state: "light_sleep",
    lastCycleDate: dateKey,
    queue: store.state.queue ?? [],
    lastCycle: { dateKey, completedAtMs: deps.nowMs(), handoff, archives, memoryHits },
  });

  return { resetCount: archives.length, memoryHitCount: memoryHits.length, archives };
}

export function createSleepDeepTool(deps: SleepDeepDeps) {
  return {
    name: "sleep_deep",
    description:
      "Nightly deep-sleep: archive + reset the long-lived conversation session(s) so their transcript stops growing (this is the prompt-cache cost fix), and stage a waking summary (handoff + vector-ranked memories) for the next session. Fired by the sleep-cycle cron; safe to call manually. Takes no arguments.",
    parameters: {
      type: "object" as const,
      additionalProperties: false,
      properties: {},
    },
    async execute(_toolCallId: string, _args: unknown) {
      try {
        const r = await runDeepSleep(deps);
        return textResult(
          `sleep_deep complete: reset ${r.resetCount} session(s); staged waking summary with ${r.memoryHitCount} memory hit(s).`,
        );
      } catch (err) {
        return textResult(`sleep_deep error: ${String(err)}`);
      }
    },
  };
}
