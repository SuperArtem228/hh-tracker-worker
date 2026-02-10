export type Env = {
  BOT_TOKEN: string;
};

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
    console.log("Telegram sendMessage failed:", res.status, await res.text());
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
    console.log("Telegram sendPhoto failed:", res.status, await res.text());
  }
}

export async function sendTelegramDocument(env: Env, chatId: number | string, filename: string, content: string, caption?: string) {
  if (!env.BOT_TOKEN) return;

  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);

  // Cloudflare Workers поддерживает Blob/File
  const blob = new Blob([content], { type: "text/csv; charset=utf-8" });
  form.append("document", blob, filename);

  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    console.log("Telegram sendDocument failed:", res.status, await res.text());
  }
}
