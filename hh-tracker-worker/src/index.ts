import { Hono } from "hono";
import { parseHHBuffer } from "./parser";
import {
  addResponses,
  appendToBuffer,
  clearBuffer,
  ensureUser,
  getBuffer,
  getUserStats,
  markUpdateProcessed,
  updateLastAckAt,
} from "./storage";
import { sendTelegramMessage } from "./telegram";

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; is_bot: boolean; first_name: string; username?: string };
    chat: { id: number; type: string };
    date: number;
    text?: string;
  };
};

type Env = {
  DB: D1Database;
  BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.text("ok"));

function formatStats(stats: Awaited<ReturnType<typeof getUserStats>>): string {
  const order = ["Не просмотрен", "Просмотрен", "Тестовое", "Приглашение", "Собеседование", "Отказ"];
  const lines = order
    .filter((s) => stats.statusBreakdown[s] != null)
    .map((s) => `${s}: ${stats.statusBreakdown[s]}`);

  const other = Object.entries(stats.statusBreakdown)
    .filter(([k]) => !order.includes(k))
    .map(([k, v]) => `${k}: ${v}`);

  const breakdown = [...lines, ...other].map((l) => `• ${l}`).join("\n") || "• пока пусто";
  const top = stats.topCompanies.map((c) => `${c.name} (${c.count})`).join(", ") || "—";
  const last7 = stats.dailyActivity.slice(-7);
  const activity = last7.length ? last7.map((d) => `${d.date}: ${d.count}`).join("\n") : "—";

  return (
    `📊 Статистика за 30 дней\n\n` +
    `Всего откликов: ${stats.totalResponses}\n\n` +
    `По статусам:\n${breakdown}\n\n` +
    `Топ компаний: ${top}\n\n` +
    `Активность (последние 7 дней):\n${activity}`
  );
}

async function processUpdate(env: Env, update: TelegramUpdate) {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text.trim();
  const isCommand = text.startsWith("/");

  const user = await ensureUser({ DB: env.DB }, userId, chatId);

  if (isCommand) {
    const [cmd, ...args] = text.split(" ");

    switch (cmd) {
      case "/start":
        await sendTelegramMessage(env, chatId, (
          "Привет! Я HH Tracker.\n\n" +
          "Как пользоваться:\n" +
          "1) /new\n" +
          "2) Вставляй копипасту из hh.ru (можно частями)\n" +
          "3) /done — я распарсю и сохраню\n\n" +
          "Команды:\n" +
          "/new — очистить буфер\n" +
          "/done — распарсить и сохранить\n" +
          "/stats — статистика за 30 дней\n" +
          "/reset — очистить буфер"
        ));
        return;

      case "/new":
      case "/reset":
        await clearBuffer({ DB: env.DB }, userId);
        await sendTelegramMessage(env, chatId, "Ок. Буфер очищен. Теперь кидай текст из hh, потом /done.");
        return;

      case "/done": {
        const bufferText = await getBuffer({ DB: env.DB }, userId);
        if (!bufferText) {
          await sendTelegramMessage(env, chatId, "Буфер пустой. Вставь текст из hh и потом /done.");
          return;
        }

        const parsed = parseHHBuffer(bufferText);
        if (parsed.length === 0) {
          await sendTelegramMessage(
            env,
            chatId,
            "Ничего не распарсил. Проверь, что вставляешь список откликов + статус (Отказ/Просмотрен/...)."
          );
          return;
        }

        const { inserted, duplicates } = await addResponses({ DB: env.DB }, userId, parsed);
        await clearBuffer({ DB: env.DB }, userId);

        await sendTelegramMessage(
          env,
          chatId,
          `Готово. Добавлено: ${inserted}. Дублей: ${duplicates}.\n\nНапиши /stats, чтобы посмотреть статистику.`
        );
        return;
      }

      case "/stats": {
        const stats = await getUserStats({ DB: env.DB }, userId, 30);
        await sendTelegramMessage(env, chatId, formatStats(stats));
        return;
      }

      case "/connect": {
        // В Cloudflare-версии мы пока не делаем Sheets.
        // Команда оставлена, чтобы потом не ломать привычку.
        const email = args[0];
        if (!email) {
          await sendTelegramMessage(env, chatId, "Экспорт в Google Sheets пока отключён.");
        } else {
          await sendTelegramMessage(env, chatId, "Экспорт в Google Sheets пока отключён.");
        }
        return;
      }

      default:
        await sendTelegramMessage(env, chatId, "Не понял команду. Напиши /start.");
        return;
    }
  }

  // Обычный текст => добавляем в буфер
  await appendToBuffer({ DB: env.DB }, userId, text);

  // анти-спам: отвечаем "Принял" не чаще 1 раза в 5 секунд
  const now = Date.now();
  if (!user.last_ack_at || now - user.last_ack_at > 5000) {
    await updateLastAckAt({ DB: env.DB }, userId, now);
    await sendTelegramMessage(env, chatId, "Принял. Можешь прислать ещё или /done.");
  }
}

app.post("/telegram", async (c) => {
  // 1) secret_token проверка (если задана)
  const configured = c.env.TELEGRAM_WEBHOOK_SECRET;
  const got = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (configured && got !== configured) {
    return c.json({ ok: false, error: "Invalid secret token" }, 403);
  }

  const update = (await c.req.json().catch(() => null)) as TelegramUpdate | null;
  if (!update || typeof update.update_id !== "number") {
    return c.json({ ok: true });
  }

  // 2) идемпотентность по update_id
  const isNew = await markUpdateProcessed({ DB: c.env.DB }, update.update_id);
  if (!isNew) {
    return c.json({ ok: true });
  }

  // 3) сразу отвечаем Telegram 200, а обработку делаем в фоне
  c.executionCtx.waitUntil(
    processUpdate(c.env, update).catch(async (e) => {
      console.log("processUpdate error", e);
      const chatId = update?.message?.chat?.id;
      if (chatId) {
        await sendTelegramMessage(c.env, chatId, "Ошибка при обработке. Попробуй ещё раз или /start.");
      }
    })
  );

  return c.json({ ok: true });
});

export default app;
