/**
 * Attack logger — writes security incidents to a separate log stream.
 *
 * Inspired by panasonic chat_api log_incident_to_slack_and_s3():
 *   - Separate log path from normal history (easy to grep for attacks)
 *   - Immediate Telegram alert with incident details
 *   - Structured JSON for SFT training data pipeline
 *
 * Log path: ~/.openclaw/logs/attacks/YYYY/MM/DD/<incidentId>.json
 */

import fs from "node:fs";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { sendTelegramMessage } from "./telegram.js";

export type IncidentType =
  | "prompt_injection"
  | "social_engineering"
  | "data_exfiltration_attempt"
  | "unauthorized_tool_use"
  | "system_abuse"
  | "policy_violation"
  | "other";

export type IncidentRecord = {
  incidentId: string;
  incidentType: IncidentType;
  ts: string;
  sessionId?: string;
  agentId?: string;
  detail: string;
  suspiciousContent?: string;
  context?: Record<string, unknown>;
};

export type AttackLogHandle = {
  log(record: Omit<IncidentRecord, "incidentId" | "ts">): Promise<void>;
};

function resolveAttackLogPath(logDir: string, incidentId: string): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return path.join(logDir, year, month, day, `${incidentId}.json`);
}

function formatTelegramAlert(record: IncidentRecord): string {
  const lines = [
    `🚨 *Hyperclaw Security Alert*`,
    ``,
    `*Type:* \`${record.incidentType}\``,
    `*Incident ID:* \`${record.incidentId}\``,
    `*Session:* \`${record.sessionId ?? "unknown"}\``,
    `*Time:* ${record.ts}`,
    ``,
    `*Detail:*`,
    record.detail.slice(0, 400),
  ];
  if (record.suspiciousContent) {
    lines.push(``, `*Suspicious content (first 300 chars):*`);
    lines.push(`\`\`\`\n${record.suspiciousContent.slice(0, 300)}\n\`\`\``);
  }
  return lines.join("\n");
}

export function registerAttackLogger(
  _api: OpenClawPluginApi,
  opts: {
    logDir: string;
    telegram: { botToken?: string; chatId?: string };
  },
): AttackLogHandle {
  const { logDir, telegram } = opts;

  return {
    async log(partial) {
      const incidentId = crypto.randomUUID();
      const record: IncidentRecord = {
        incidentId,
        ts: new Date().toISOString(),
        ...partial,
      };

      // Write to disk (write-only from agent perspective)
      try {
        const filePath = resolveAttackLogPath(logDir, incidentId);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
      } catch (err) {
        console.error("[hyperclaw-security] Failed to write attack log:", err);
      }

      // Send Telegram alert (non-blocking, best-effort)
      if (telegram.botToken && telegram.chatId) {
        sendTelegramMessage({
          botToken: telegram.botToken,
          chatId: telegram.chatId,
          text: formatTelegramAlert(record),
          parseMode: "Markdown",
        }).catch((err) => {
          console.error("[hyperclaw-security] Failed to send Telegram alert:", err);
        });
      }
    },
  };
}
