import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { z } from "zod";
import { registerSecretsRedact } from "./src/hooks/secrets-redact.js";
import { SecretsStore } from "./src/secrets-store.js";
import { createDepositSecretTool } from "./src/tools/deposit-secret.js";

const configSchema = z.object({
  secretsDir: z.string().optional(),
  telegramBotToken: z.string().optional(),
  telegramAlertChatId: z.string().optional(),
});

export type SecretsVaultConfig = z.infer<typeof configSchema>;

const plugin = {
  id: "secrets-vault",
  name: "Secrets Vault",
  description:
    "AES-256-GCM at-rest secrets store, deposit_secret tool, history redaction hook.",

  configSchema: {
    parse(raw: unknown) {
      return configSchema.parse(raw ?? {});
    },
  },

  register(api: OpenClawPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig ?? {});
    const stateDir = api.runtime?.stateDir ?? (process.env.HOME + "/.openclaw");
    const secretsDir = cfg.secretsDir ?? `${stateDir}/state/secrets`;

    const telegramCfg = {
      botToken: cfg.telegramBotToken,
      chatId: cfg.telegramAlertChatId,
    };

    // Encrypted at-rest store. The agent never sees the plaintext after deposit;
    // it gets an opaque handle that re-materializes only inside tool calls.
    const secretsStore = new SecretsStore({ dir: secretsDir, stateDir });

    // Agent-callable tool — the model invokes this when the user pastes a
    // credential into chat. Returns the handle; emits an optional Telegram
    // confirmation so the operator knows a secret landed in the vault.
    api.registerTool(createDepositSecretTool({ secretsStore, telegram: telegramCfg }));

    // Belt-and-suspenders redaction hook — runs before any history write to
    // ensure no plaintext secret slips into JSONL transcripts.
    registerSecretsRedact(api, { secretsStore });

    api.logger.info("secrets-vault plugin loaded", {
      secretsDir,
      telegramConfigured: Boolean(cfg.telegramBotToken && cfg.telegramAlertChatId),
    });
  },
};

export default plugin;
