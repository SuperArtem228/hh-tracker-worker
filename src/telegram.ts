
console.log("WEBHOOK HIT")

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
