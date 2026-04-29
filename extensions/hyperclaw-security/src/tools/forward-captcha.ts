/**
 * Captcha Forwarding Tool
 *
 * When the agent encounters a CAPTCHA, this tool:
 * 1. Takes a screenshot of the CAPTCHA
 * 2. Sends it to Mike via Telegram
 * 3. Waits for Mike's solution
 * 4. Returns the solution to the agent
 *
 * This keeps the human-in-the-loop for CAPTCHA challenges while allowing
 * the agent to continue automation flows.
 */

import { sendTelegramMessage, sendTelegramPhoto } from "../telegram.js";

export interface CaptchaForwardConfig {
  telegramBotToken: string;
  telegramChatId: string;
  timeoutSeconds?: number;
}

// Store pending captcha requests for response matching
const pendingCaptchas = new Map<
  string,
  {
    resolve: (solution: string | null) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

export type ForwardCaptchaTool = {
  label: string;
  name: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    args: unknown,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
};

export function createForwardCaptchaTool(config: CaptchaForwardConfig): ForwardCaptchaTool {
  const timeoutMs = (config.timeoutSeconds ?? 300) * 1000;

  return {
    label: "Forward CAPTCHA",
    name: "forward_captcha",
    description: `Forward a CAPTCHA image to Mike for manual solving. Use this when you encounter a CAPTCHA that blocks automation. Provide a screenshot of the CAPTCHA and context about where it appeared. Mike will solve it and return the solution.`,
    parameters: {
      type: "object",
      properties: {
        screenshot_base64: {
          type: "string",
          description: "Base64-encoded PNG screenshot of the CAPTCHA",
        },
        captcha_type: {
          type: "string",
          enum: ["text", "image_select", "recaptcha", "hcaptcha", "cloudflare", "other"],
          description: "Type of CAPTCHA encountered",
        },
        url: {
          type: "string",
          description: "URL where the CAPTCHA appeared",
        },
        context: {
          type: "string",
          description: "What you were trying to do when the CAPTCHA appeared",
        },
      },
      required: ["screenshot_base64", "captcha_type", "url", "context"],
    },

    async execute(_toolCallId, args) {
      const params = args as {
        screenshot_base64?: string;
        captcha_type?: string;
        url?: string;
        context?: string;
      };
      const screenshot_base64 = params.screenshot_base64 ?? "";
      const captcha_type = params.captcha_type ?? "other";
      const url = params.url ?? "unknown";
      const context = params.context ?? "unknown";

      const requestId = `captcha_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const message = [
        `🔐 **CAPTCHA Request**`,
        ``,
        `**Type:** ${captcha_type}`,
        `**URL:** ${url}`,
        `**Context:** ${context}`,
        ``,
        `Reply with the CAPTCHA solution, or "skip" to skip this CAPTCHA.`,
        `Request ID: \`${requestId}\``,
      ].join("\n");

      // Send the screenshot
      try {
        const imageBuffer = Buffer.from(screenshot_base64, "base64");
        await sendTelegramPhoto({
          botToken: config.telegramBotToken,
          chatId: config.telegramChatId,
          photo: imageBuffer,
          caption: message,
          parseMode: "Markdown",
        });
      } catch (err) {
        // Fallback to text-only if photo fails
        await sendTelegramMessage({
          botToken: config.telegramBotToken,
          chatId: config.telegramChatId,
          text: `${message}\n\n⚠️ Screenshot upload failed: ${err}`,
          parseMode: "Markdown",
        });
      }

      // Wait for response (polling-based for simplicity)
      // In production, this would use Telegram webhook callbacks
      const solution = await new Promise<string | null>((resolve) => {
        const timeout = setTimeout(() => {
          pendingCaptchas.delete(requestId);
          resolve(null);
        }, timeoutMs);

        pendingCaptchas.set(requestId, { resolve, timeout });
      });

      if (solution === null) {
        return {
          content: [
            { type: "text" as const, text: "CAPTCHA request timed out. No solution received." },
          ],
        };
      }

      if (solution.toLowerCase() === "skip") {
        return {
          content: [{ type: "text" as const, text: "CAPTCHA skipped by user." }],
        };
      }

      return {
        content: [{ type: "text" as const, text: `CAPTCHA solved. Solution: ${solution}` }],
      };
    },
  };
}

/**
 * Handle incoming Telegram message that might be a CAPTCHA solution.
 * Call this from the Telegram message handler.
 */
export function handlePotentialCaptchaSolution(messageText: string): boolean {
  // Look for "reply to captcha_xxx: solution" pattern
  const match = messageText.match(/captcha_\w+/i);
  if (!match) {
    return false;
  }

  const requestId = match[0].toLowerCase();
  const pending = pendingCaptchas.get(requestId);
  if (!pending) {
    return false;
  }

  // Extract solution (everything after the request ID or colon)
  const colonIndex = messageText.indexOf(":");
  const solution =
    colonIndex !== -1
      ? messageText.slice(colonIndex + 1).trim()
      : messageText.replace(/captcha_\w+/i, "").trim();

  clearTimeout(pending.timeout);
  pendingCaptchas.delete(requestId);
  pending.resolve(solution || null);

  return true;
}
