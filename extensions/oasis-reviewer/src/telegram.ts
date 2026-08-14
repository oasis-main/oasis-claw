/**
 * Minimal Telegram Bot API client — text-message send only.
 *
 * Deliberate COPY of extensions/prompt-injection-reporting/src/telegram.ts, not a
 * cross-plugin import — see that file's own header comment: the full client (inline
 * keyboards, photo upload) lives in the approval-gate plugin, and each plugin that
 * needs to send a Telegram message keeps its own slim copy for this stable, low-LOC
 * HTTP boilerplate.
 *
 * oasis-reviewer uses this ONLY for the independent report_injection review's own
 * follow-up alert (see reviewer.ts's formatInjectionReviewAlert / injectionReviewMode).
 * It never touches report_injection's own log/alert path
 * (extensions/prompt-injection-reporting/src/attack-logger.ts), which keeps firing
 * unconditionally exactly as it does today.
 */

export type TelegramSendOpts = {
  botToken: string;
  chatId: string;
  text: string;
  parseMode?: "Markdown" | "HTML" | "MarkdownV2";
};

const TELEGRAM_API = "https://api.telegram.org";

export async function sendTelegramMessage(opts: TelegramSendOpts): Promise<void> {
  const res = await fetch(`${TELEGRAM_API}/bot${opts.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: opts.chatId,
      text: opts.text,
      parse_mode: opts.parseMode,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Telegram sendMessage failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) {
    throw new Error(`Telegram sendMessage error: ${data.description ?? "unknown"}`);
  }
}
