import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { z } from "zod";
import { createForwardCaptchaTool } from "./src/tools/forward-captcha.js";

/**
 * Approval Gate plugin.
 *
 * What's currently wired:
 *   - forward_captcha agent tool (sends CAPTCHA images to operator via Telegram
 *     and waits for the human-typed solution)
 *
 * What ships as library code, awaiting core integration:
 *   - api-approval-gate.ts — utility functions for HTTP request approval policy
 *     (loadApiApprovalPolicy, checkApiApproval, requestApiApproval). These need
 *     to be invoked from openclaw's HTTP middleware layer; the integration point
 *     does not yet exist in vanilla upstream and tracks under oasis-x ORG-049.
 *   - browser-approvals.ts — documentation describing how to configure
 *     openclaw's existing exec approval infrastructure (approvals.exec.targets)
 *     to forward browser navigation requests to Telegram. No code wiring needed
 *     in the plugin; the configuration goes in ~/.openclaw/openclaw.json.
 */

const configSchema = z.object({
  telegramBotToken: z.string().optional(),
  telegramChatId: z.string().optional(),
  policyFile: z.string().optional(),
});

export type ApprovalGateConfig = z.infer<typeof configSchema>;

const plugin = {
  id: "approval-gate",
  name: "Approval Gate",
  description:
    "Human-in-the-loop approval surface — CAPTCHA forwarding (wired), API approval policy + browser approval config (library code, integrates via openclaw core hooks).",

  configSchema: {
    parse(raw: unknown) {
      return configSchema.parse(raw ?? {});
    },
  },

  register(api: OpenClawPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig ?? {});

    // forward_captcha tool — the model invokes this when it encounters a
    // CAPTCHA in a browser session. Image is sent to Telegram; operator's
    // text reply becomes the tool's return value.
    if (cfg.telegramBotToken && cfg.telegramChatId) {
      api.registerTool(
        createForwardCaptchaTool({
          telegramBotToken: cfg.telegramBotToken,
          telegramChatId: cfg.telegramChatId,
        }),
      );
    } else {
      api.logger.warn(
        "approval-gate: forward_captcha tool not registered — telegramBotToken + telegramChatId must both be configured",
      );
    }

    api.logger.info("approval-gate plugin loaded", {
      forwardCaptchaWired: Boolean(cfg.telegramBotToken && cfg.telegramChatId),
      apiApprovalLibraryAvailable: true,
      browserApprovalsAvailable: "via ~/.openclaw/openclaw.json approvals.exec config",
    });
  },
};

// Re-export library code for callers that wire it into core hooks.
export {
  loadApiApprovalPolicy,
  checkApiApproval,
  requestApiApproval,
  handlePotentialApiApprovalResponse,
} from "./src/api-approval-gate.js";

export default plugin;
