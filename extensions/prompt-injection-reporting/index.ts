import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { z } from "zod";
import { registerAttackLogger } from "./src/attack-logger.js";
import { createReportInjectionTool } from "./src/tools/report-injection.js";

const configSchema = z.object({
  telegramBotToken: z.string().optional(),
  telegramAlertChatId: z.string().optional(),
  attackLogDir: z.string().optional(),
});

export type PromptInjectionReportingConfig = z.infer<typeof configSchema>;

const plugin = {
  id: "prompt-injection-reporting",
  name: "Prompt Injection Reporting",
  description:
    "Agent-callable report_injection tool + signed JSONL attack log + Telegram alert.",

  configSchema: {
    parse(raw: unknown) {
      return configSchema.parse(raw ?? {});
    },
  },

  register(api: OpenClawPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig ?? {});
    const stateDir = api.runtime?.stateDir ?? (process.env.HOME + "/.openclaw");
    const attackLogDir = cfg.attackLogDir ?? `${stateDir}/logs/attacks`;

    // Same bot identity as every other alerting plugin on this bot — one
    // literal per env var (docker-compose env_file), not one persisted copy
    // per plugin config block in openclaw.json. cfg.* stays as an explicit
    // manual override, never written by the entrypoint.
    const telegramCfg = {
      botToken: cfg.telegramBotToken ?? process.env.OASIS_TELEGRAM_BOT_TOKEN,
      chatId: cfg.telegramAlertChatId ?? process.env.OASIS_TELEGRAM_CHAT_ID,
    };

    // Attack logger — appends signed JSONL on every report_injection call,
    // emits a Telegram alert if configured.
    const attackLog = registerAttackLogger(api, {
      logDir: attackLogDir,
      telegram: telegramCfg,
    });

    // Agent-callable tool — the model invokes this when it detects what it
    // believes is a prompt-injection attempt in its input.
    api.registerTool(createReportInjectionTool({ attackLog }));

    api.logger.info("prompt-injection-reporting plugin loaded", {
      attackLogDir,
      telegramConfigured: Boolean(cfg.telegramBotToken && cfg.telegramAlertChatId),
    });
  },
};

export default plugin;
