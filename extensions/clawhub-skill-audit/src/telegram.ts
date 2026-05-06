/**
 * Slim Telegram sender — one-shot text alert. Deliberately a copy of the slim
 * client in prompt-injection-reporting/src/telegram.ts so each plugin stays
 * self-contained at the package boundary.
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
