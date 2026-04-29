/**
 * Telegram Bot API client used by approval-gate for approval prompts
 * (sendTelegramMessage with optional inline keyboards) and CAPTCHA
 * forwarding (sendTelegramPhoto).
 *
 * The dead `editTelegramMessage` helper that lived in the original
 * hyperclaw-security bundle was never called and has been removed.
 */

export type TelegramSendOpts = {
  botToken: string;
  chatId: string;
  text: string;
  parseMode?: "Markdown" | "HTML" | "MarkdownV2";
  replyMarkup?: TelegramInlineKeyboard;
};

export type TelegramInlineKeyboard = {
  inline_keyboard: TelegramInlineButton[][];
};

export type TelegramInlineButton = {
  text: string;
  callback_data: string;
};

export type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  text?: string;
};

const TELEGRAM_API = "https://api.telegram.org";

async function telegramPost(
  botToken: string,
  method: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Telegram API ${method} failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as {
    ok: boolean;
    result?: unknown;
    description?: string;
  };
  if (!data.ok) {
    throw new Error(`Telegram API ${method} error: ${data.description ?? "unknown"}`);
  }
  return data.result;
}

export async function sendTelegramMessage(opts: TelegramSendOpts): Promise<TelegramMessage> {
  return (await telegramPost(opts.botToken, "sendMessage", {
    chat_id: opts.chatId,
    text: opts.text,
    parse_mode: opts.parseMode,
    reply_markup: opts.replyMarkup,
  })) as TelegramMessage;
}

export type TelegramPhotoOpts = {
  botToken: string;
  chatId: string;
  photo: Buffer;
  caption?: string;
  parseMode?: "Markdown" | "HTML" | "MarkdownV2";
};

export async function sendTelegramPhoto(opts: TelegramPhotoOpts): Promise<TelegramMessage> {
  const formData = new FormData();
  formData.append("chat_id", opts.chatId);
  formData.append("photo", new Blob([opts.photo], { type: "image/png" }), "captcha.png");
  if (opts.caption) {
    formData.append("caption", opts.caption);
  }
  if (opts.parseMode) {
    formData.append("parse_mode", opts.parseMode);
  }

  const res = await fetch(`${TELEGRAM_API}/bot${opts.botToken}/sendPhoto`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Telegram API sendPhoto failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    ok: boolean;
    result?: TelegramMessage;
    description?: string;
  };
  if (!data.ok || !data.result) {
    throw new Error(`Telegram API sendPhoto error: ${data.description ?? "unknown"}`);
  }

  return data.result;
}
