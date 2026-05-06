/**
 * clawhub-skill-audit — auto-audit clawhub skills with Opus 4.7 on install.
 *
 * Hook surface:
 *   1. SDK skills-change listener (registerSkillsChangeListener) — fires when
 *      openclaw's own watcher notices a skill snapshot change. This catches
 *      `clawhub install` runs while the gateway is up.
 *   2. Debounced periodic scan — covers first-boot (skills already on disk
 *      before the listener registered) and out-of-band installs (someone
 *      cp'd a skill directory in by hand).
 *
 * Dedupe is content-hash based (skillId@sha256(files)), so re-installs of an
 * already-audited version are a no-op but a malicious update *does* trigger
 * a re-audit.
 *
 * Verdict actions:
 *   pass   — log only
 *   warn   — log + Telegram alert (if configured)
 *   block  — log + Telegram alert + (optional) move skill to quarantineDir
 *
 * The plugin never blocks the install path itself — by design, openclaw
 * delegates skill discovery to the workspace fs, and we don't want to race
 * the loader. Quarantine is the after-the-fact teeth.
 */

import path from "node:path";
import fs from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerSkillsChangeListener } from "openclaw/plugin-sdk/skills-runtime";
import { z } from "zod";
import { runAudit } from "./src/auditor.js";
import { createAuditStore } from "./src/audit-store.js";
import { findAllSkills } from "./src/skill-scanner.js";
import { sendTelegramMessage } from "./src/telegram.js";

const configSchema = z.object({
  anthropicApiKey: z.string().optional(),
  auditModel: z.string().optional(),
  skillsDirs: z.array(z.string()).optional(),
  auditLogDir: z.string().optional(),
  quarantineDir: z.string().optional(),
  telegramBotToken: z.string().optional(),
  telegramAlertChatId: z.string().optional(),
  pollIntervalMs: z.number().optional(),
  maxBytesPerFile: z.number().optional(),
  maxFilesPerSkill: z.number().optional(),
});

export type ClawhubSkillAuditConfig = z.infer<typeof configSchema>;

const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_MAX_BYTES = 65_536;
const DEFAULT_MAX_FILES = 25;

function defaultSkillsDirs(): string[] {
  const home = process.env.HOME ?? "";
  return [
    path.resolve("./skills"),
    path.join(home, ".openclaw/skills"),
    path.join(home, ".openclaw/workspace/skills"),
  ];
}

const plugin = {
  id: "clawhub-skill-audit",
  name: "ClawHub Skill Audit",
  description:
    "Opus 4.7 auto-audits every newly installed clawhub skill and writes an immutable audit trail.",

  configSchema: {
    parse(raw: unknown) {
      return configSchema.parse(raw ?? {});
    },
  },

  register(api: OpenClawPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig ?? {});
    const stateDir = api.runtime?.stateDir ?? `${process.env.HOME}/.openclaw`;

    const apiKey = cfg.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    const auditModel = cfg.auditModel ?? DEFAULT_MODEL;
    const skillsDirs = cfg.skillsDirs ?? defaultSkillsDirs();
    const auditLogDir = cfg.auditLogDir ?? `${stateDir}/logs/skill-audits`;
    const quarantineDir = cfg.quarantineDir;
    const pollIntervalMs = cfg.pollIntervalMs ?? DEFAULT_POLL_MS;
    const scanOpts = {
      maxBytesPerFile: cfg.maxBytesPerFile ?? DEFAULT_MAX_BYTES,
      maxFilesPerSkill: cfg.maxFilesPerSkill ?? DEFAULT_MAX_FILES,
    };
    const telegram = {
      botToken: cfg.telegramBotToken,
      chatId: cfg.telegramAlertChatId,
    };

    const store = createAuditStore({ logDir: auditLogDir });

    if (!apiKey) {
      api.logger.warn(
        "clawhub-skill-audit: no ANTHROPIC_API_KEY available — plugin loaded but audits will fail with verdict=error until a key is provided.",
      );
    }

    let auditing = false;

    const auditNow = async (reason: string) => {
      if (auditing) return;
      auditing = true;
      try {
        const snapshots = findAllSkills(skillsDirs, scanOpts);
        const fresh = snapshots.filter((s) => !store.hasAudited(s));
        if (fresh.length === 0) return;
        api.logger.info(
          `clawhub-skill-audit: ${fresh.length} new/changed skill(s) detected (${reason})`,
        );
        for (const snap of fresh) {
          if (!apiKey) {
            store.record(snap, {
              verdict: "error",
              risk_score: -1 as unknown as number,
              summary: "no anthropic api key configured",
              findings: [],
              auditModel,
              auditedAt: new Date().toISOString(),
              latencyMs: 0,
              errorDetail: "missing ANTHROPIC_API_KEY",
            });
            continue;
          }
          const verdict = await runAudit(snap, { apiKey, model: auditModel });
          const record = store.record(snap, verdict);
          api.logger.info(
            `clawhub-skill-audit: ${snap.skillId} → ${verdict.verdict} (risk ${verdict.risk_score}, ${verdict.findings.length} finding(s), ${verdict.latencyMs}ms) audit=${record.auditId}`,
          );

          if (verdict.verdict === "warn" || verdict.verdict === "block") {
            if (telegram.botToken && telegram.chatId) {
              sendTelegramMessage({
                botToken: telegram.botToken,
                chatId: telegram.chatId,
                text: formatTelegramAlert(record),
                parseMode: "Markdown",
              }).catch((err) =>
                api.logger.warn(`clawhub-skill-audit: telegram alert failed: ${String(err)}`),
              );
            }
          }

          if (verdict.verdict === "block" && quarantineDir) {
            try {
              quarantineSkill(snap.baseDir, quarantineDir, record.auditId);
              api.logger.warn(
                `clawhub-skill-audit: quarantined ${snap.skillId} → ${quarantineDir}`,
              );
            } catch (err) {
              api.logger.warn(
                `clawhub-skill-audit: quarantine failed for ${snap.skillId}: ${String(err)}`,
              );
            }
          }
        }
      } catch (err) {
        api.logger.warn(`clawhub-skill-audit: audit pass failed: ${String(err)}`);
      } finally {
        auditing = false;
      }
    };

    // Debounce: skills-change events can cluster (one install touches many
    // files). Coalesce within a 1.5s window.
    let debounceTimer: NodeJS.Timeout | undefined;
    const scheduleAudit = (reason: string) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        void auditNow(reason);
      }, 1500);
    };

    registerSkillsChangeListener((event) => {
      scheduleAudit(`sdk:${event.reason}`);
    });

    // Periodic fallback scan; unref so a long interval never keeps the
    // process alive at shutdown.
    const pollTimer = setInterval(() => void auditNow("poll"), pollIntervalMs);
    if (typeof pollTimer.unref === "function") pollTimer.unref();

    // First-boot pass — handles skills already on disk before we attached.
    void auditNow("startup");

    api.logger.info("clawhub-skill-audit plugin loaded", {
      auditModel,
      auditLogDir,
      skillsDirs,
      quarantineConfigured: Boolean(quarantineDir),
      telegramConfigured: Boolean(telegram.botToken && telegram.chatId),
      apiKeyPresent: Boolean(apiKey),
    });
  },
};

function formatTelegramAlert(record: {
  auditId: string;
  skillId: string;
  verdict: { verdict: string; risk_score: number; summary: string; findings: ReadonlyArray<{ category: string; severity: string; file: string; detail: string }> };
}): string {
  const v = record.verdict;
  const icon = v.verdict === "block" ? "⛔" : v.verdict === "warn" ? "⚠️" : "ℹ️";
  const lines = [
    `${icon} *ClawHub Skill Audit*`,
    ``,
    `*Skill:* \`${record.skillId}\``,
    `*Verdict:* \`${v.verdict}\` (risk ${v.risk_score})`,
    `*Audit ID:* \`${record.auditId}\``,
    ``,
    `*Summary:* ${v.summary.slice(0, 400)}`,
  ];
  if (v.findings.length) {
    lines.push(``, `*Findings:*`);
    for (const f of v.findings.slice(0, 5)) {
      lines.push(`• \`${f.severity}/${f.category}\` ${f.file} — ${f.detail.slice(0, 200)}`);
    }
    if (v.findings.length > 5) lines.push(`...and ${v.findings.length - 5} more`);
  }
  return lines.join("\n");
}

function quarantineSkill(baseDir: string, quarantineDir: string, auditId: string): void {
  fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
  const skillId = path.basename(baseDir);
  const dest = path.join(quarantineDir, `${skillId}.${auditId}`);
  fs.renameSync(baseDir, dest);
  fs.writeFileSync(
    path.join(dest, "QUARANTINED.txt"),
    `Quarantined by clawhub-skill-audit at ${new Date().toISOString()}\nAudit id: ${auditId}\n`,
    { mode: 0o600 },
  );
}

export default plugin;
