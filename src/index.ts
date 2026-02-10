import { Hono } from "hono";
import { parseHHBuffer } from "./parser";
import {
  addResponses,
  appendToBuffer,
  clearBuffer,
  ensureUser,
  getBuffer,
  getUserSheet,
  getUserStats,
  listUserResponses,
  markUpdateProcessed,
  updateLastAckAt,
  upsertUserSheet,
  clearUserSheet,
} from "./storage";
import { sendTelegramMessage } from "./telegram";
import { appendRows, clearAndWriteAll, createAndShareSpreadsheet } from "./google";

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
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
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
          "/connect <email> — создать таблицу Google Sheets и подключить экспорт\n" +
          "/sheet — ссылка на твою таблицу\n" +
          "/sync — пересобрать таблицу из базы\n" +
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

        const { inserted, duplicates, insertedRows } = await addResponses({ DB: env.DB }, userId, parsed);
        await clearBuffer({ DB: env.DB }, userId);

        const sheet = await getUserSheet({ DB: env.DB }, userId);
        let sheetNote = "";
        if (sheet && insertedRows.length) {
          try {
            const rows = insertedRows.map((p) => [
              p.responseDate ?? "",
              p.company,
              p.title,
              p.status,
              p.roleFamily,
              p.grade,
            ]);
            await appendRows(env, sheet.spreadsheet_id, rows);
            sheetNote = `\n\nТаблица обновлена: https://docs.google.com/spreadsheets/d/${sheet.spreadsheet_id}/edit`;
          } catch (e) {
            console.log("Sheets append error", e);
            sheetNote =
              `\n\n⚠️ В Google Sheets не записал (в базу всё сохранил). ` +
              `Сделай /sync, чтобы пересобрать таблицу.`;
          }
        } else if (sheet && !insertedRows.length) {
          sheetNote = `\n\nТаблица: https://docs.google.com/spreadsheets/d/${sheet.spreadsheet_id}/edit`;
        }

        await sendTelegramMessage(
          env,
          chatId,
          `Готово. Добавлено: ${inserted}. Дублей: ${duplicates}.` + sheetNote + `\n\nНапиши /stats, чтобы посмотреть статистику.`
        );
        return;
      }

      case "/stats": {
        const stats = await getUserStats({ DB: env.DB }, userId, 30);
        await sendTelegramMessage(env, chatId, formatStats(stats));
        return;
      }

      case "/sheet": {
        const sheet = await getUserSheet({ DB: env.DB }, userId);
        if (!sheet) {
          await sendTelegramMessage(env, chatId, "Таблица не подключена. Напиши /connect you@gmail.com");
          return;
        }
        await sendTelegramMessage(env, chatId, `Твоя таблица:
https://docs.google.com/spreadsheets/d/${sheet.spreadsheet_id}/edit`);
        return;
      }

      case "/sync": {
        const sheet = await getUserSheet({ DB: env.DB }, userId);
        if (!sheet) {
          await sendTelegramMessage(env, chatId, "Таблица не подключена. Напиши /connect you@gmail.com");
          return;
        }
        if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
          await sendTelegramMessage(env, chatId, "Экспорт в Google Sheets не настроен на сервере (нет GOOGLE_SERVICE_ACCOUNT_JSON).");
          return;
        }

        try {
          const all = await listUserResponses({ DB: env.DB }, userId, 2000);
          const rows = all.map((r) => [
            r.response_date ?? "",
            r.company,
            r.title,
            r.status,
            r.role_family,
            r.grade,
          ]);
          await clearAndWriteAll(env, sheet.spreadsheet_id, rows);
          await sendTelegramMessage(
            env,
            chatId,
            `Ок. Пересобрал таблицу (${rows.length} строк):
https://docs.google.com/spreadsheets/d/${sheet.spreadsheet_id}/edit`
          );
        } catch (e) {
          console.log("sync error", e);
          await sendTelegramMessage(env, chatId, "Не получилось пересобрать таблицу. Попробуй позже.");
        }
        return;
      }

      case "/disconnect": {
        await clearUserSheet({ DB: env.DB }, userId);
        await sendTelegramMessage(env, chatId, "Ок. Таблицу отключил. Если надо снова — /connect you@gmail.com");
        return;
      }

      case "/connect": {
        const email = args[0]?.trim();
        if (!email) {
          await sendTelegramMessage(
            env,
            chatId,
            `Чтобы подключить Google Sheets, напиши:
/connect you@gmail.com

Я создам таблицу и расшарю её на этот email.`
          );
          return;
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          await sendTelegramMessage(env, chatId, "Похоже, email странный. Пример: /connect you@gmail.com");
          return;
        }

        if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
          await sendTelegramMessage(
            env,
            chatId,
            "Экспорт в Google Sheets не настроен на сервере (нет GOOGLE_SERVICE_ACCOUNT_JSON)."
          );
          return;
        }

        const existing = await getUserSheet({ DB: env.DB }, userId);
        if (existing && existing.email.toLowerCase() === email.toLowerCase()) {
          await sendTelegramMessage(
            env,
            chatId,
            `Уже подключено: ${existing.email}
Таблица: https://docs.google.com/spreadsheets/d/${existing.spreadsheet_id}/edit

Если хочешь пересобрать — /sync.`
          );
          return;
        }

        await sendTelegramMessage(env, chatId, "Ок. Создаю таблицу и подключаю…");

        try {
          const title = `HH Tracker — ${email}`;
          const info = await createAndShareSpreadsheet(env, title, email);

          await upsertUserSheet({ DB: env.DB }, userId, email, info.spreadsheetId);

          // Первый экспорт: сразу кладём текущие данные из базы в таблицу
          const all = await listUserResponses({ DB: env.DB }, userId, 2000);
          const rows = all.map((r) => [
            r.response_date ?? "",
            r.company,
            r.title,
            r.status,
            r.role_family,
            r.grade,
          ]);
          await clearAndWriteAll(env, info.spreadsheetId, rows);

          await sendTelegramMessage(
            env,
            chatId,
            `Готово. Таблица создана и расшарена на ${email}:
${info.url}

Дальше она будет обновляться после /done. Если нужно пересобрать — /sync.`
          );
        } catch (e) {
          console.log("connect error", e);
          await sendTelegramMessage(env, chatId, "Не получилось создать/расшарить таблицу. Проверь настройки Google Sheets и попробуй ещё раз.");
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

export default app.fetch;
