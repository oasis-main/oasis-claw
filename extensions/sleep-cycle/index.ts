/**
 * sleep-cycle — biomimetic nightly session lifecycle for oasis-claw bots.
 *
 * Driven by openclaw's CRON (not a plugin background timer — openclaw's plugin
 * runtime does not run a plugin's setInterval; verified 2026-07-13). Two
 * reliable primitives only:
 *
 *   - `sleep_deep` TOOL — archives + resets the long-lived conversation
 *     session(s) so their transcript stops growing (the prompt-cache cost
 *     fix), and stages a waking summary. Fired nightly by a light-context
 *     agentTurn cron (session: isolated, tools: [sleep_deep]) that the runtime
 *     entrypoint auto-installs. Tools execute reliably in the gateway process.
 *
 *   - waking-summary SUPPLEMENT — injects the previous session's handoff tail,
 *     archived-transcript pointers, and vector-ranked memories into the next
 *     session's memory prompt (morning-gated, read fresh from the state file).
 *
 * The dream step stays owned by memory-core's dreaming cron (22:20). There is
 * no custom mutex: openclaw already serializes turns per session, so an inbound
 * message during the deep-sleep turn queues naturally.
 */

import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { z } from "zod";
import { type BeforeResetEvent, handleBeforeReset } from "./src/before-reset.js";
import { type ContextNapConfig, createContextNapHooks } from "./src/context-nap.js";
import { createSleepDeepTool, runDeepSleep, type SleepDeepConfig } from "./src/deep-tool.js";
import { createGatewayCaller } from "./src/gateway-cli.js";
import { loadState, StateStore } from "./src/state-store.js";
import { buildWakingLines, type WakingConfig } from "./src/waking.js";

const configSchema = z.object({
  enabled: z.boolean().optional(),
  timezone: z.string().optional(),
  // Kept for entrypoint cron-schedule derivation + operator readability; the
  // plugin itself only needs timezone/sessionMatch/wakingSummary at runtime.
  dozeAt: z.string().optional(),
  deepSleepAt: z.string().optional(),
  wakeAt: z.string().optional(),
  sessionMatch: z.array(z.string()).optional(),
  wakingSummary: z
    .object({
      enabled: z.boolean().optional(),
      memoryHits: z.number().optional(),
      transcriptPointers: z.number().optional(),
      injectUntilHour: z.number().optional(),
    })
    .optional(),
  contextNap: z
    .object({
      enabled: z.boolean().optional(),
      thresholdRatio: z.number().optional(),
      preemptTokens: z.number().optional(),
      guardTokens: z.number().optional(),
      minAbsoluteTokens: z.number().optional(),
      minMsBetweenNaps: z.number().optional(),
      message: z.string().optional(),
    })
    .optional(),
  semanticsEndpoint: z.string().optional(),
  semanticsModel: z.string().optional(),
});

type ResolvedConfig = {
  enabled: boolean;
  timezone: string;
  sessionMatch: string[];
  wakingSummary: {
    enabled: boolean;
    memoryHits: number;
    transcriptPointers: number;
    injectUntilHour: number;
  };
  contextNap: ContextNapConfig;
  semanticsEndpoint: string;
  semanticsModel: string;
};

const NAP_MESSAGE_DEFAULT =
  "Attention exhausted. Clean-up & refresh required. Taking a quick power nap...";

function resolveConfig(raw: unknown): ResolvedConfig {
  const cfg = configSchema.parse(raw ?? {});
  return {
    enabled: cfg.enabled ?? true,
    timezone: cfg.timezone ?? "America/New_York",
    sessionMatch: cfg.sessionMatch ?? ["telegram:direct"],
    wakingSummary: {
      enabled: cfg.wakingSummary?.enabled ?? true,
      memoryHits: cfg.wakingSummary?.memoryHits ?? 5,
      transcriptPointers: cfg.wakingSummary?.transcriptPointers ?? 3,
      // 24 = inject whenever a session is fresh (within the 20h freshness
      // window in buildWakingLines), regardless of clock hour. Deep sleep can
      // run off-schedule (e.g. a mid-day manual reset to relieve a rate
      // limit), and the handoff should follow the reset, not wait for the next
      // morning. Lower this only if you want a morning-only cutoff.
      injectUntilHour: cfg.wakingSummary?.injectUntilHour ?? 24,
    },
    contextNap: {
      enabled: cfg.contextNap?.enabled ?? true,
      // 0.85 of the ACTIVE model's window — model-aware, so a 32K fallback naps
      // ~6x sooner than a 200K primary for the same work.
      thresholdRatio: cfg.contextNap?.thresholdRatio ?? 0.85,
      // = compaction.reserveTokensFloor (5000) + softThreshold (4000). The nap
      // fires before this line so we reset instead of paying native compaction.
      // Keep in sync with the entrypoint's compaction reserve.
      preemptTokens: cfg.contextNap?.preemptTokens ?? 9000,
      guardTokens: cfg.contextNap?.guardTokens ?? 1500,
      minAbsoluteTokens: cfg.contextNap?.minAbsoluteTokens ?? 2000,
      minMsBetweenNaps: cfg.contextNap?.minMsBetweenNaps ?? 60_000,
      message: cfg.contextNap?.message ?? NAP_MESSAGE_DEFAULT,
      // Nap-eligible sessions = the same long-lived conversational sessions the
      // nightly deep-sleep targets; ephemeral cron/heartbeat sessions are left
      // to native compaction (they're short and auto-pruned).
      sessionMatch: cfg.sessionMatch ?? ["telegram:direct"],
    },
    semanticsEndpoint: cfg.semanticsEndpoint ?? "http://oasis-semantics:8732",
    semanticsModel: cfg.semanticsModel ?? "default",
  };
}

const plugin = {
  id: "sleep-cycle",
  name: "Sleep Cycle",
  description:
    "Biomimetic nightly session lifecycle: a cron-fired sleep_deep tool archives+resets the long-lived conversation session(s) (prompt-cache cost fix) and stages a waking summary, injected into the next session by a memory-prompt supplement.",

  configSchema: {
    parse(raw: unknown) {
      return configSchema.parse(raw ?? {});
    },
  },

  register(api: OpenClawPluginApi) {
    const cfg = resolveConfig(api.pluginConfig ?? {});
    if (!cfg.enabled) {
      return;
    }

    const homeDir = process.env.HOME ?? os.homedir();
    const workspaceDir = path.join(homeDir, ".openclaw", "workspace");
    const stateDir = path.join(homeDir, ".openclaw", "state", "sleep-cycle");
    const store = new StateStore(stateDir);

    const deepCfg: SleepDeepConfig = {
      timezone: cfg.timezone,
      sessionMatch: cfg.sessionMatch,
      wakingSummary: cfg.wakingSummary,
      semanticsEndpoint: cfg.semanticsEndpoint,
      semanticsModel: cfg.semanticsModel,
    };

    // One gateway caller (loopback RPC via the CLI + gateway token), shared by
    // the manual sleep_deep tool AND the context-nap reset.
    const call = createGatewayCaller();

    // AUTOMATIC path: openclaw's own scheduled session reset (native
    // `session.reset` policy, seeded by the runtime entrypoint) archives the
    // long-lived transcript and starts fresh — no cron, no tool, no admin
    // scope. This hook rides that reset: when a scheduled ("daily"/"idle")
    // reset is about to fire, it captures the handoff tail + vector-ranks
    // memories and stages the waking summary. openclaw does the reset; we carry
    // continuity forward.
    api.on("before_reset", (event: BeforeResetEvent) =>
      handleBeforeReset(event, {
        cfg: deepCfg,
        workspaceDir,
        store,
        nowMs: () => Date.now(),
        log: (m) => api.logger?.info?.(`sleep-cycle: ${m}`),
      }),
    );

    // ON-DEMAND path: a manual `sleep_deep` tool for off-schedule resets (e.g.
    // relieving a rate limit mid-day). Self-contained (its own capture); it
    // reports reset reason "reset"/"new", which the before_reset hook skips, so
    // the two paths never double-write. Needs operator.admin to drive
    // sessions.reset via the gateway CLI — fine on approved bots, a manual-only
    // limitation on fresh ones (the automatic path above needs no scope).
    api.registerTool(
      createSleepDeepTool({
        cfg: deepCfg,
        homeDir,
        workspaceDir,
        call,
        store,
        nowMs: () => Date.now(),
      }),
    );

    // CONTEXT-THRESHOLD path: nap when a session's live prompt crosses a
    // fraction of the ACTIVE model's window (pre-empting native compaction),
    // announce it on that turn's reply, then run the SAME archive+reset+
    // waking-summary cycle as the nightly deep-sleep. Continuity is preserved
    // (archived transcript + waking handoff + memories); only the working
    // window is refreshed. Driven off per-turn hooks — openclaw runs no plugin
    // background timer.
    if (cfg.contextNap.enabled) {
      const napHooks = createContextNapHooks({
        cfg: cfg.contextNap,
        nowMs: () => Date.now(),
        log: (m) => api.logger?.info?.(`sleep-cycle: ${m}`),
        runNap: async (sessionKey) => {
          await runDeepSleep({
            cfg: deepCfg,
            homeDir,
            workspaceDir,
            call,
            store,
            nowMs: () => Date.now(),
            overrideTargetKeys: [sessionKey],
            log: (m) => api.logger?.info?.(`sleep-cycle: ${m}`),
          });
        },
      });
      api.on("llm_output", napHooks.onLlmOutput);
      api.on("message_sending", napHooks.onMessageSending);
      api.on("agent_end", napHooks.onAgentEnd);
    }

    // Waking summary — read fresh from the state file each time so it reflects
    // the sleep_deep tool's most recent write.
    const wakingCfg: WakingConfig = {
      timezone: cfg.timezone,
      wakingSummary: cfg.wakingSummary,
    };
    api.registerMemoryPromptSupplement(() =>
      buildWakingLines(loadState(stateDir), wakingCfg, Date.now()),
    );
  },
};

export default plugin;
