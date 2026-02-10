export type Env = {
  BOT_TOKEN: string;
};

async function safeLogResponse(prefix: string, res: Response) {
  try {
    const text = await res.text();
    console.log(prefix, res.status, text);
  } catch (e) {
    console.log(prefix, res.status, "(failed to read body)");
  }
}

export async function sendTelegramMessage(env: Env, chatId: number | string, text: string) {
  if (!env.BOT_TOKEN) return;

  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    // Не бросаем ошибку — чтобы вебхук не начинал ретраи.
    await safeLogResponse("Telegram sendMessage failed:", res);
  }
}

export async function sendTelegramDocument(
  env: Env,
  chatId: number | string,
  filename: string,
  contentType: string,
  content: string | ArrayBuffer | Uint8Array,
  caption?: string
) {
  if (!env.BOT_TOKEN) return;

  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);

  const blob =
    typeof content === "string"
      ? new Blob([content], { type: contentType })
      : content instanceof Uint8Array
        ? new Blob([content], { type: contentType })
        : new Blob([content], { type: contentType });

  form.append("document", blob, filename);

  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    await safeLogResponse("Telegram sendDocument failed:", res);
  }
}

export async function sendTelegramPhoto(env: Env, chatId: number | string, photoUrl: string, caption?: string) {
  if (!env.BOT_TOKEN) return;

  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      photo: photoUrl,
      caption,
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    await safeLogResponse("Telegram sendPhoto failed:", res);
  }
}
