export type TelegramEnv = {
  BOT_TOKEN: string;
};

export type SendMessageOptions = {
  reply_markup?: unknown;
  parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
  disable_web_page_preview?: boolean;
};

type TelegramApiResult = { ok: boolean; description?: string };

async function postJson<T>(env: TelegramEnv, method: string, body: unknown): Promise<TelegramApiResult & T> {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    console.log(`Telegram ${method} failed:`, res.status, text);
    return { ok: false, description: text } as TelegramApiResult & T;
  }

  try {
    return JSON.parse(text) as TelegramApiResult & T;
  } catch {
    return { ok: false, description: "Invalid JSON from Telegram" } as TelegramApiResult & T;
  }
}

export async function sendTelegramMessage(
  env: TelegramEnv,
  chatId: number | string,
  text: string,
  opts: SendMessageOptions = {}
) {
  if (!env.BOT_TOKEN) return;
  await postJson(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: opts.disable_web_page_preview ?? true,
    parse_mode: opts.parse_mode,
    reply_markup: opts.reply_markup,
  });
}

export async function answerTelegramCallbackQuery(
  env: TelegramEnv,
  callbackQueryId: string,
  text?: string
) {
  if (!env.BOT_TOKEN) return;
  await postJson(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  });
}

export async function sendTelegramDocument(
  env: TelegramEnv,
  chatId: number | string,
  filename: string,
  content: string | Uint8Array,
  caption?: string
) {
  if (!env.BOT_TOKEN) return;

  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);

  const blob =
    typeof content === "string"
      ? new Blob([content], { type: "text/csv;charset=utf-8" })
      : new Blob(
          [
            // TS ругается на SharedArrayBuffer в типах (ArrayBufferLike), поэтому явно приводим.
            content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer,
          ],
          { type: "text/csv" }
        );

  form.append("document", blob, filename);

  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    console.log("Telegram sendDocument failed:", res.status, await res.text());
  }
}

export type MediaGroupItem = {
  type: "photo";
  media: string; // URL
  caption?: string;
  parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
};

export async function sendTelegramMediaGroup(env: TelegramEnv, chatId: number | string, media: MediaGroupItem[]) {
  if (!env.BOT_TOKEN) return;
  await postJson(env, "sendMediaGroup", {
    chat_id: chatId,
    media,
  });
}
