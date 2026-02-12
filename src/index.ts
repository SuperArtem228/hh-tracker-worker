import { Hono } from "hono";
import { parseHHBuffer } from "./parser";
import { enrichCompanies } from "./enrich";
import {
  addResponses,
  addInterviewEntry,
  appendToBuffer,
  clearBuffer,
  clearUserState,
  ensureUser,
  getBuffer,
  getUserState,
  getUserStatsV2,
  listUserResponses,
  markUpdateProcessed,
  setUserState,
  updateLastAckAt,
} from "./storage";
import { answerTelegramCallbackQuery, sendTelegramDocument, sendTelegramMediaGroup, sendTelegramMessage } from "./telegram";
import { buildFullFunnelChart, buildGradePieChart, buildRolePieChart, buildStatusFunnelChart, periodTitle } from "./charts";

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; is_bot: boolean; first_name: string; username?: string };
    chat: { id: number; type: string };
    date: number;
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; is_bot: boolean; first_name: string; username?: string };
    message?: {
      message_id: number;
      chat: { id: number; type: string };
    };
    data?: string;
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

function mainMenuMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "➕ Новый импорт", callback_data: "new" },
        { text: "✅ Завершить импорт", callback_data: "done" },
      ],
      [{ text: "➕ Добавить собесы", callback_data: "add_interviews" }],
      [
        { text: "📊 Статистика", callback_data: "stats" },
        { text: "📈 Отчёт", callback_data: "report" },
      ],
      [{ text: "⬇️ Экспорт CSV", callback_data: "export" }],
      [{ text: "🔗 Таблица", callback_data: "sheet" }],
      [{ text: "ℹ️ Как пользоваться", callback_data: "help" }],
    ],
  };
}

function periodMenuMarkup(prefix: "stats" | "report" | "export") {
  return {
    inline_keyboard: [
      [
        { text: "Неделя", callback_data: `${prefix}:week` },
        { text: "Месяц", callback_data: `${prefix}:month` },
        { text: "Всё время", callback_data: `${prefix}:all` },
      ],
      [{ text: "⬅️ В меню", callback_data: "menu" }],
    ],
  };
}

function backToMenuMarkup() {
  return { inline_keyboard: [[{ text: "⬅️ В меню", callback_data: "menu" }]] };
}

function cancelMarkup() {
  return { inline_keyboard: [[{ text: "✖️ Отмена", callback_data: "cancel" }]] };
}

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

  const interviews =
    `• Скрининг: ${stats.interviews.screening}\n` +
    `• HR: ${stats.interviews.hr}\n` +
    `• Техничка: ${stats.interviews.technical}\n` +
    `• Оффер: ${stats.interviews.offer}`;

  return (
    `📊 Статистика (${periodTitle(stats.period)})\n\n` +
    `Всего откликов: ${stats.total}\n\n` +
    `По статусам:\n${statuses}\n\n` +
    `Собеседования (вручную):\n${interviews}\n\n` +
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

function afterDoneMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "➕ Добавить собесы", callback_data: "add_interviews" },
        { text: "⬅️ В меню", callback_data: "menu" },
      ],
    ],
  };
}

function parseCountsFromText(text: string): number[] {
  const nums = text.match(/\d+/g) ?? [];
  return nums.map((n) => Number(n)).filter((n) => Number.isFinite(n));
}

function isValidCount(n: number) {
  return Number.isInteger(n) && n >= 0 && n <= 9999;
}

async function showMenu(env: Env, chatId: number | string, text = "Меню") {
  await sendTelegramMessage(env, chatId, text, { reply_markup: mainMenuMarkup() });
}

async function startInterviewWizard(env: Env, chatId: number | string, userId: number) {
  await setUserState({ DB: env.DB }, userId, "interviews_screening", {});
  await sendTelegramMessage(
    env,
    chatId,
    "Ок, добавим собеседования.\n\n" +
      "Можно двумя способами:\n" +
      "• одним сообщением: 1 2 0 0 (скрининг HR техничка оффер)\n" +
      "• или по одному числу на вопрос\n\n" +
      "Сколько было скринингов?",
    { reply_markup: cancelMarkup() }
  );
}

async function handleInterviewInput(env: Env, chatId: number | string, userId: number, text: string) {
  const st = await getUserState({ DB: env.DB }, userId);
  if (!st) return false;

  const data = (() => {
    try {
      return (st.data ? (JSON.parse(st.data) as any) : {}) as Record<string, any>;
    } catch {
      return {} as Record<string, any>;
    }
  })();

  const counts = parseCountsFromText(text);

  // Быстрый ввод: 4 числа за раз
  if (st.state === "interviews_screening" && counts.length >= 4) {
    const [screening, hr, technical, offer] = counts;
    if (![screening, hr, technical, offer].every(isValidCount)) {
      await sendTelegramMessage(env, chatId, "Похоже, числа странные. Дай 4 неотрицательных целых, например: 1 2 0 0", {
        reply_markup: cancelMarkup(),
      });
      return true;
    }
    await addInterviewEntry({ DB: env.DB }, userId, { screening, hr, technical, offer });
    await clearUserState({ DB: env.DB }, userId);
    await sendTelegramMessage(
      env,
      chatId,
      `Записал. Скрининг ${screening}, HR ${hr}, техничка ${technical}, оффер ${offer}.`,
      { reply_markup: mainMenuMarkup() }
    );
    return true;
  }

  // Пошаговый ввод: одно число
  const n = counts[0];
  if (!isValidCount(n)) {
    await sendTelegramMessage(env, chatId, "Нужна цифра 0–9999. Например: 0", { reply_markup: cancelMarkup() });
    return true;
  }

  if (st.state === "interviews_screening") {
    data.screening = n;
    await setUserState({ DB: env.DB }, userId, "interviews_hr", data);
    await sendTelegramMessage(env, chatId, "Сколько было HR-собесов?", { reply_markup: cancelMarkup() });
    return true;
  }

  if (st.state === "interviews_hr") {
    data.hr = n;
    await setUserState({ DB: env.DB }, userId, "interviews_technical", data);
    await sendTelegramMessage(env, chatId, "Сколько было техничек?", { reply_markup: cancelMarkup() });
    return true;
  }

  if (st.state === "interviews_technical") {
    data.technical = n;
    await setUserState({ DB: env.DB }, userId, "interviews_offer", data);
    await sendTelegramMessage(env, chatId, "Сколько было офферов?", { reply_markup: cancelMarkup() });
    return true;
  }

  if (st.state === "interviews_offer") {
    data.offer = n;
    const screening = Number(data.screening ?? 0);
    const hr = Number(data.hr ?? 0);
    const technical = Number(data.technical ?? 0);
    const offer = Number(data.offer ?? 0);
    await addInterviewEntry({ DB: env.DB }, userId, { screening, hr, technical, offer });
    await clearUserState({ DB: env.DB }, userId);
    await sendTelegramMessage(
      env,
      chatId,
      `Записал. Скрининг ${screening}, HR ${hr}, техничка ${technical}, оффер ${offer}.`,
      { reply_markup: mainMenuMarkup() }
    );
    return true;
  }

  return false;
}

async function handleDoneImport(env: Env, chatId: number | string, userId: number) {
  const bufferText = await getBuffer({ DB: env.DB }, userId);
  if (!bufferText) {
    await sendTelegramMessage(env, chatId, "Буфер пустой. Нажми ‘➕ Новый импорт’, вставь текст из hh и потом ‘✅ Завершить импорт’.", {
      reply_markup: mainMenuMarkup(),
    });
    return;
  }

  const parsed = parseHHBuffer(bufferText);
  if (parsed.length === 0) {
    await sendTelegramMessage(
      env,
      chatId,
      "Ничего не распарсил. Проверь, что вставляешь список откликов + статус (Отказ/Просмотрен/...).",
      { reply_markup: mainMenuMarkup() }
    );
    return;
  }

  const { inserted, duplicates } = await addResponses({ DB: env.DB }, userId, parsed);
  await clearBuffer({ DB: env.DB }, userId);

  enrichCompanies({ DB: env.DB }, parsed.map((p) => p.company), 30).catch(() => {});

  await sendTelegramMessage(
    env,
    chatId,
    `Готово. Добавлено: ${inserted}. Дублей: ${duplicates}.\n\nХочешь — сразу добавим собеседования (вручную).`,
    { reply_markup: afterDoneMarkup() }
  );
}

async function sendHelp(env: Env, chatId: number | string) {
  await sendTelegramMessage(
    env,
    chatId,
    "Как пользоваться:\n" +
      "1) ➕ Новый импорт\n" +
      "2) Вставь копипасту из hh.ru (можно частями)\n" +
      "3) ✅ Завершить импорт\n" +
      "4) (опционально) ➕ Добавить собесы\n\n" +
      "Дальше: Статистика / Отчёт / Экспорт — выбираешь период кнопками.\n\n" +
      "Команды тоже поддерживаются: /new, /done, /stats [week|month|all], /report [week|month|all], /export [week|month|all].",
    { reply_markup: mainMenuMarkup() }
  );
}

async function processUpdate(env: Env, update: TelegramUpdate) {
  const msg = update.message;
  const cb = update.callback_query;

  const chatId = msg?.chat.id ?? cb?.message?.chat.id;
  const userId = msg?.from?.id ?? cb?.from?.id;
  if (chatId == null || userId == null) return;

  const user = await ensureUser({ DB: env.DB }, userId, Number(chatId));

  // 1) Inline кнопки
  if (cb) {
    await answerTelegramCallbackQuery(env, cb.id).catch(() => {});
    const data = (cb.data ?? "").trim();

    // Нажатия по меню считаем явным действием => выходим из пошагового ввода
    if (data && data !== "cancel") {
      await clearUserState({ DB: env.DB }, userId).catch(() => {});
    }

    if (data === "menu") {
      await showMenu(env, chatId);
      return;
    }

    if (data === "new") {
      await clearBuffer({ DB: env.DB }, userId);
      await sendTelegramMessage(
        env,
        chatId,
        "Ок. Буфер очищен. Теперь кидай текст из hh.ru (можно частями), потом нажми ‘✅ Завершить импорт’.",
        { reply_markup: mainMenuMarkup() }
      );
      return;
    }

    if (data === "done") {
      await handleDoneImport(env, chatId, userId);
      return;
    }

    if (data === "add_interviews") {
      await startInterviewWizard(env, chatId, userId);
      return;
    }

    if (data === "cancel") {
      await clearUserState({ DB: env.DB }, userId);
      await showMenu(env, chatId, "Ок, отменил.");
      return;
    }

    if (data === "help") {
      await sendHelp(env, chatId);
      return;
    }

    if (data === "stats") {
      await sendTelegramMessage(env, chatId, "Выбери период для статистики:", { reply_markup: periodMenuMarkup("stats") });
      return;
    }

    if (data.startsWith("stats:")) {
      const period = parsePeriodArg(data.split(":")[1]);
      const stats = await getUserStatsV2({ DB: env.DB }, userId, period);
      await sendTelegramMessage(env, chatId, formatStats(stats), { reply_markup: backToMenuMarkup() });
      return;
    }

    if (data === "report") {
      await sendTelegramMessage(env, chatId, "Выбери период для отчёта:", { reply_markup: periodMenuMarkup("report") });
      return;
    }

    if (data.startsWith("report:")) {
      const period = parsePeriodArg(data.split(":")[1]);
      const stats = await getUserStatsV2({ DB: env.DB }, userId, period);

      await sendTelegramMessage(env, chatId, formatStats(stats), { reply_markup: backToMenuMarkup() });

      const media = [
        {
          type: "photo" as const,
          media: buildFullFunnelChart(stats),
          caption: `Воронка (отклики + собесы) (${periodTitle(stats.period)})`,
        },
        {
          type: "photo" as const,
          media: buildStatusFunnelChart(stats),
          caption: `Статусы откликов (${periodTitle(stats.period)})`,
        },
        {
          type: "photo" as const,
          media: buildGradePieChart(stats),
          caption: `Грейды (${periodTitle(stats.period)})`,
        },
        {
          type: "photo" as const,
          media: buildRolePieChart(stats),
          caption: `Роли (${periodTitle(stats.period)})`,
        },
      ];

      await sendTelegramMediaGroup(env, chatId, media);
      return;
    }

    if (data === "export") {
      await sendTelegramMessage(env, chatId, "Выбери период для экспорта:", { reply_markup: periodMenuMarkup("export") });
      return;
    }

    if (data.startsWith("export:")) {
      const period = parsePeriodArg(data.split(":")[1]);
      const rows = await listUserResponses({ DB: env.DB }, userId, period);
      const csv = buildCsv(rows);

      const stats = await getUserStatsV2({ DB: env.DB }, userId, period);
      await sendTelegramMessage(
        env,
        chatId,
        `Готово. CSV за ${periodTitle(period)}. Строк: ${rows.length}.\n\nВсего откликов: ${stats.total}.`,
        { reply_markup: backToMenuMarkup() }
      );

      const filename = `hh_responses_${period}_${new Date().toISOString().slice(0, 10)}.csv`;
      await sendTelegramDocument(env, chatId, filename, csv);
      return;
    }

    if (data === "sheet") {
      const url = env.SHEET_URL;
      if (!url) {
        await sendTelegramMessage(env, chatId, "Ссылка на таблицу не настроена. (Можно добавить переменную SHEET_URL в Worker.)", {
          reply_markup: backToMenuMarkup(),
        });
      } else {
        await sendTelegramMessage(env, chatId, `Таблица (общая): ${url}`, { reply_markup: backToMenuMarkup() });
      }
      return;
    }

    // неизвестная кнопка
    await showMenu(env, chatId);
    return;
  }

  // 2) Обычные сообщения
  if (!msg?.text) return;
  const text = msg.text.trim();
  const isCommand = text.startsWith("/");

  if (isCommand) {
    const [cmd, ...args] = text.split(" ");

    switch (cmd) {
      case "/start":
        await sendTelegramMessage(
          env,
          chatId,
          (
            "Привет! Я CSS-трекер.\n" +
            "Я собираю отклики из hh.ru (ты просто копипастишь список) и считаю воронку.\n" +
            "Плюс можно руками добавить собеседования (скрининг, HR, техничка, оффер), чтобы видеть картину целиком.\n\n" +
            "Быстрый сценарий:\n" +
            "1) Нажми ‘➕ Новый импорт’\n" +
            "2) Вставь копипасту из hh.ru (можно частями)\n" +
            "3) Нажми ‘✅ Завершить импорт’\n" +
            "4) Если надо — добавь собесы\n\n" +
            "Меню ниже. Если любишь слэши — команды тоже работают: /new, /done, /stats, /report, /export"
          ),
          { reply_markup: mainMenuMarkup() }
        );
        return;

      case "/menu":
        await showMenu(env, chatId);
        return;

      case "/interviews":
      case "/sobes":
        await startInterviewWizard(env, chatId, userId);
        return;

      case "/cancel":
        await clearUserState({ DB: env.DB }, userId);
        await showMenu(env, chatId, "Ок, отменил.");
        return;

      case "/new":
      case "/reset":
        await clearBuffer({ DB: env.DB }, userId);
        await sendTelegramMessage(env, chatId, "Ок. Буфер очищен. Теперь кидай текст из hh.ru (можно частями), потом /done.", {
          reply_markup: mainMenuMarkup(),
        });
        return;

      case "/done": {
        await handleDoneImport(env, chatId, userId);
        return;
      }

      case "/stats": {
        const period = parsePeriodArg(args[0]);
        const stats = await getUserStatsV2({ DB: env.DB }, userId, period);
        await sendTelegramMessage(env, chatId, formatStats(stats), { reply_markup: mainMenuMarkup() });
        return;
      }

      case "/report": {
        const period = parsePeriodArg(args[0]);
        const stats = await getUserStatsV2({ DB: env.DB }, userId, period);

        await sendTelegramMessage(env, chatId, formatStats(stats), { reply_markup: mainMenuMarkup() });

        const media = [
          {
            type: "photo" as const,
            media: buildFullFunnelChart(stats),
            caption: `Воронка (отклики + собесы) (${periodTitle(stats.period)})`,
          },
          {
            type: "photo" as const,
            media: buildStatusFunnelChart(stats),
            caption: `Статусы откликов (${periodTitle(stats.period)})`,
          },
          {
            type: "photo" as const,
            media: buildGradePieChart(stats),
            caption: `Грейды (${periodTitle(stats.period)})`,
          },
          {
            type: "photo" as const,
            media: buildRolePieChart(stats),
            caption: `Роли (${periodTitle(stats.period)})`,
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
          `Готово. CSV за ${periodTitle(period)}. Строк: ${rows.length}.\n\nВсего откликов: ${stats.total}.`,
          { reply_markup: mainMenuMarkup() }
        );

        const filename = `hh_responses_${period}_${new Date().toISOString().slice(0, 10)}.csv`;
        await sendTelegramDocument(env, chatId, filename, csv);
        return;
      }

      case "/sheet": {
        const url = env.SHEET_URL;
        if (!url) {
          await sendTelegramMessage(env, chatId, "Ссылка на таблицу не настроена. (Можно добавить переменную SHEET_URL в Worker.)", {
            reply_markup: mainMenuMarkup(),
          });
        } else {
          await sendTelegramMessage(env, chatId, `Таблица (общая): ${url}`, { reply_markup: mainMenuMarkup() });
        }
        return;
      }

      case "/connect": {
        await sendTelegramMessage(env, chatId, "Google Sheets отключён. Используй /export для CSV.");
        return;
      }

      default:
        await sendTelegramMessage(env, chatId, "Не понял. Нажми /start или открой меню.", { reply_markup: mainMenuMarkup() });
        return;
    }
  }

  // если человек сейчас вводит собесы — не кладём это в буфер
  const handled = await handleInterviewInput(env, chatId, userId, text);
  if (handled) return;

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
      const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
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


