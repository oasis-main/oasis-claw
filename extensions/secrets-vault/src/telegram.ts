/**
 * Minimal Telegram Bot API client — text-message send only.
 * Used by secrets-vault to confirm deposits to the operator chat.
 *
 * The full client (with inline keyboards, message editing, photo upload)
 * lives in the approval-gate plugin; this slim copy avoids cross-plugin
 * imports for what is otherwise stable, low-LOC HTTP boilerplate.
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
