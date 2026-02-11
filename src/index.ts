import { Hono } from "hono";
import { parseHHBuffer } from "./parser";
import {
  addResponses,
  appendToBuffer,
  clearBuffer,
  ensureUser,
  getBuffer,
  getUserStatsV2,
  listUserResponses,
  markUpdateProcessed,
  updateLastAckAt,
} from "./storage";
import { sendTelegramDocument, sendTelegramMediaGroup, sendTelegramMessage } from "./telegram";
import { buildGradePieChart, buildRolePieChart, buildStatusFunnelChart, periodTitle } from "./charts";

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
  SHEET_URL?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.text("ok"));

function formatStats(stats: Awaited<ReturnType<typeof getUserStatsV2>>): string {
  const statusOrder = ["Не просмотрен", "Просмотрен", "Тестовое", "Приглашение", "Собеседование", "Отказ"];
  const roleLabels: Record<string, string> = {
    product: "Product",
    project: "Project",
    product_marketing: "Product Marketing",
    product_analytics: "Product Analytics",
    other: "Other",
  };
  const gradeLabels: Record<string, string> = {
    junior: "Junior",
    middle: "Middle",
    senior: "Senior",
  };

  const statuses = [...statusOrder, ...Object.keys(stats.status).filter((k) => !statusOrder.includes(k))]
    .filter((k, i, arr) => arr.indexOf(k) === i)
    .filter((k) => stats.status[k] != null)
    .map((k) => `• ${k}: ${stats.status[k]}`)
    .join("\n") || "• пока пусто";

  const grades = Object.keys(gradeLabels)
    .filter((k) => stats.grade[k] != null)
    .map((k) => `• ${gradeLabels[k]}: ${stats.grade[k]}`)
    .join("\n") || "• пока пусто";

  const roles = Object.keys(roleLabels)
    .filter((k) => stats.roleFamily[k] != null)
    .map((k) => `• ${roleLabels[k]}: ${stats.roleFamily[k]}`)
    .join("\n") || "• пока пусто";

  const top = stats.topCompanies.map((c) => `${c.name} (${c.count})`).join(", ") || "—";

  return (
    `📊 Статистика (${periodTitle(stats.period)})\n\n` +
    `Всего откликов: ${stats.total}\n\n` +
    `По статусам:\n${statuses}\n\n` +
    `Грейды:\n${grades}\n\n` +
    `Роли:\n${roles}\n\n` +
    `Топ компаний: ${top}`
  );
}

function parsePeriodArg(arg?: string): "week" | "month" | "all" {
  const a = (arg ?? "").trim().toLowerCase();
  if (a === "week" || a === "7" || a === "7d" || a === "нед" || a === "неделя") return "week";
  if (a === "month" || a === "30" || a === "30d" || a === "мес" || a === "месяц") return "month";
  if (a === "all" || a === "все" || a === "всё" || a === "весь") return "all";
  // дефолт: месяц
  return "month";
}

function escapeCsvCell(value: string): string {
  const v = value.replaceAll("\r", " ").replaceAll("\n", " ");
  if (/[\",;]/.test(v)) return `"${v.replaceAll('"', '""')}"`;
  return v;
}

function buildCsv(rows: Awaited<ReturnType<typeof listUserResponses>>): string {
  const header = ["imported_at", "response_date", "status", "grade", "role", "company", "title"].join(";");
  const lines = rows.map((r) =>
    [
      r.imported_at,
      r.response_date ?? "",
      r.status,
      r.grade,
      r.role_family,
      r.company,
      r.title,
    ]
      .map((c) => escapeCsvCell(String(c)))
      .join(";")
  );
  return [header, ...lines].join("\n");
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
          "/stats [week|month|all] — статистика\n" +
          "/report [week|month|all] — статистика + графики\n" +
          "/export [week|month|all] — CSV выгрузка\n" +
          "/sheet — ссылка на общую таблицу (если настроена)"
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

        enrichCompanies({ DB: env.DB }, parsed.map((p) => p.company), 30).catch(() => {});

        await sendTelegramMessage(
          env,
          chatId,
          `Готово. Добавлено: ${inserted}. Дублей: ${duplicates}.\n\nНапиши /stats, чтобы посмотреть статистику.`
        );
        return;
      }

      case "/stats": {
        const period = parsePeriodArg(args[0]);
        const stats = await getUserStatsV2({ DB: env.DB }, userId, period);
        await sendTelegramMessage(env, chatId, formatStats(stats));
        return;
      }

      case "/report": {
        const period = parsePeriodArg(args[0]);
        const stats = await getUserStatsV2({ DB: env.DB }, userId, period);

        await sendTelegramMessage(env, chatId, formatStats(stats));

        const media = [
          {
            type: "photo" as const,
            media: buildStatusFunnelChart(stats),
            caption: `Воронка по статусам (${periodTitle(period)})`,
          },
          {
            type: "photo" as const,
            media: buildGradePieChart(stats),
            caption: `Грейды (${periodTitle(period)})`,
          },
          {
            type: "photo" as const,
            media: buildRolePieChart(stats),
            caption: `Роли (${periodTitle(period)})`,
          },
        ];

        // sendMediaGroup отдаёт одним пакетом, выглядит аккуратнее.
        await sendTelegramMediaGroup(env, chatId, media);
        return;
      }

      case "/export":
      case "/csv": {
        const period = parsePeriodArg(args[0]);
        const rows = await listUserResponses({ DB: env.DB }, userId, period);
        const csv = buildCsv(rows);

        const stats = await getUserStatsV2({ DB: env.DB }, userId, period);
        await sendTelegramMessage(
          env,
          chatId,
          `Готово. CSV за ${periodTitle(period)}. Строк: ${rows.length}.\n\nВсего откликов: ${stats.total}.\n\nХочешь графики — /report ${period}.`
        );

        const filename = `hh_responses_${period}_${new Date().toISOString().slice(0, 10)}.csv`;
        await sendTelegramDocument(env, chatId, filename, csv);
        return;
      }

      case "/sheet": {
        const url = env.SHEET_URL;
        if (!url) {
          await sendTelegramMessage(env, chatId, "Ссылка на таблицу не настроена. (Можно добавить переменную SHEET_URL в Worker.)");
        } else {
          await sendTelegramMessage(env, chatId, `Таблица (общая): ${url}`);
        }
        return;
      }

      case "/connect": {
        await sendTelegramMessage(env, chatId, "Google Sheets отключён. Используй /export для CSV.");
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

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
};


