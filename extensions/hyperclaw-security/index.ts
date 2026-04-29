import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { z } from "zod";
import { registerAttackLogger } from "./src/attack-logger.js";
import { registerHistoryLogger } from "./src/history-logger.js";
import { registerSecretsRedact } from "./src/hooks/secrets-redact.js";
import { SecretsStore } from "./src/secrets-store.js";
import { createDepositSecretTool } from "./src/tools/deposit-secret.js";
import { createReportInjectionTool } from "./src/tools/report-injection.js";

const configSchema = z.object({
  telegramBotToken: z.string().optional(),
  telegramAlertChatId: z.string().optional(),
  historyLogDir: z.string().optional(),
  attackLogDir: z.string().optional(),
  secretsDir: z.string().optional(),
});

export type HyperclawSecurityConfig = z.infer<typeof configSchema>;

const plugin = {
  id: "hyperclaw-security",
  name: "Hyperclaw Security",
  description:
    "History logging, attack detection & logging, encrypted secrets store, browser URL approvals",

  configSchema: {
    parse(raw: unknown) {
      return configSchema.parse(raw ?? {});
    },
  },

  register(api: OpenClawPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig ?? {});
    const stateDir = api.runtime?.stateDir ?? (process.env.HOME + "/.openclaw");

    const historyLogDir = cfg.historyLogDir ?? `${stateDir}/logs/history`;
    const attackLogDir = cfg.attackLogDir ?? `${stateDir}/logs/attacks`;
    const secretsDir = cfg.secretsDir ?? `${stateDir}/state/secrets`;

    const telegramCfg = {
      botToken: cfg.telegramBotToken,
      chatId: cfg.telegramAlertChatId,
    };

    // 1. History logger — hooks into llm_input/output and tool call events
    registerHistoryLogger(api, { logDir: historyLogDir });

    // 2. Attack logger + Telegram alert — model calls report_injection tool
    const attackLog = registerAttackLogger(api, { logDir: attackLogDir, telegram: telegramCfg });

    // 3. Secrets store (shared across tools)
    const secretsStore = new SecretsStore({ dir: secretsDir, stateDir });

    // 4. Agent tools
    api.registerTool(createReportInjectionTool({ attackLog }));
    api.registerTool(createDepositSecretTool({ secretsStore, telegram: telegramCfg }));

    // 5. Secrets redaction hook — belt-and-suspenders before history write
    registerSecretsRedact(api, { secretsStore });

    api.logger.info("hyperclaw-security plugin loaded", {
      historyLogDir,
      attackLogDir,
      secretsDir,
      telegramConfigured: Boolean(cfg.telegramBotToken && cfg.telegramAlertChatId),
    });
  },
};

export default plugin;
