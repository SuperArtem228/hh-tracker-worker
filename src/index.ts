import { Hono } from "hono";
import { parseHHBuffer } from "./parser";
import {
  addResponses,
  appendToBuffer,
  clearBuffer,
  ensureUser,
  getBuffer,
  getUserStats,
  listResponses,
  markUpdateProcessed,
  updateLastAckAt,
} from "./storage";
import { sendTelegramDocument, sendTelegramMessage, sendTelegramPhoto } from "./telegram";

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

const STATUS_ORDER = ["Не просмотрен", "Просмотрен", "Тестовое", "Приглашение", "Собеседование", "Отказ"];

function prettyRole(role: string): string {
  const m: Record<string, string> = {
    product: "Product",
    project: "Project",
    analyst: "Analyst",
    marketing: "Marketing",
    design: "Design",
    engineering: "Engineering",
    sales: "Sales",
    other: "Other",
  };
  return m[role] ?? role;
}

function prettyGrade(grade: string): string {
  const m: Record<string, string> = {
    junior: "Junior",
    middle: "Middle",
    senior: "Senior",
    lead: "Lead",
  };
  return m[grade] ?? grade;
}

function formatBreakdown(title: string, breakdown: Record<string, number>, mapper?: (k: string) => string): string {
  const entries = Object.entries(breakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `• ${(mapper ? mapper(k) : k)}: ${v}`);
  return `${title}\n${entries.join("\n") || "• пока пусто"}`;
}

function formatStats(stats: Awaited<ReturnType<typeof getUserStats>>, days: number): string {
  const statusLines = STATUS_ORDER
    .filter((s) => stats.statusBreakdown[s] != null)
    .map((s) => `• ${s}: ${stats.statusBreakdown[s]}`);
  const statusOther = Object.entries(stats.statusBreakdown)
    .filter(([k]) => !STATUS_ORDER.includes(k))
    .map(([k, v]) => `• ${k}: ${v}`);

  const breakdown = [...statusLines, ...statusOther].join("\n") || "• пока пусто";

  const last7 = stats.dailyActivity.slice(-7);
  const activity7 = last7.length ? last7.map((d) => `${d.date}: ${d.count}`).join("\n") : "—";

  return (
    `📊 Статистика за ${days} дней\n\n` +
    `Всего откликов: ${stats.totalResponses}\n\n` +
    `По статусам:\n${breakdown}\n\n` +
    `${formatBreakdown("По ролям:", stats.roleBreakdown, prettyRole)}\n\n` +
    `${formatBreakdown("По грейдам:", stats.gradeBreakdown, prettyGrade)}\n\n` +
    `Активность (последние 7 дней):\n${activity7}`
  );
}

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  const needs = /[;"\n\r]/.test(s);
  const out = s.replace(/"/g, '""');
  return needs ? `"${out}"` : out;
}

function toCsv(rows: Awaited<ReturnType<typeof listResponses>>): string {
  // Для Excel в RU-локали лучше ; + UTF-8 BOM
  const header = ["Response date", "Company", "Vacancy title", "Status", "Role", "Grade", "Imported at"];
  const lines = [header.join(";")];

  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.response_date ?? ""),
        csvEscape(r.company),
        csvEscape(r.title),
        csvEscape(r.status),
        csvEscape(prettyRole(r.role_family)),
        csvEscape(prettyGrade(r.grade)),
        csvEscape(r.imported_at),
      ].join(";")
    );
  }

  return "\ufeff" + lines.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

function formatTable(rows: Awaited<ReturnType<typeof listResponses>>): string {
  const header = [
    ["Date", 10],
    ["Company", 18],
    ["Title", 26],
    ["Status", 12],
    ["Role", 11],
    ["Grade", 6],
  ] as const;

  const pad = (s: string, w: number) => {
    const t = truncate(s, w);
    return t + " ".repeat(Math.max(0, w - t.length));
  };

  const headLine = header.map(([h, w]) => pad(h, w)).join(" | ");
  const sep = header.map(([_, w]) => "-".repeat(w)).join("-|-");

  const lines = rows.map((r) => {
    const date = (r.response_date ?? "").toString();
    return [
      pad(date, 10),
      pad(r.company ?? "", 18),
      pad(r.title ?? "", 26),
      pad(r.status ?? "", 12),
      pad(prettyRole(r.role_family ?? ""), 11),
      pad(prettyGrade(r.grade ?? ""), 6),
    ].join(" | ");
  });

  return "```\n" + [headLine, sep, ...lines].join("\n") + "\n```";
}

function quickChartUrl(config: unknown, w = 900, h = 500): string {
  const c = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?c=${c}&w=${w}&h=${h}&v=3&devicePixelRatio=1&format=png&backgroundColor=white`;
}

function funnelChartUrl(statusBreakdown: Record<string, number>, days: number): string {
  const labels = STATUS_ORDER;
  const data = labels.map((l) => statusBreakdown[l] ?? 0);

  const config = {
    type: "funnel",
    data: {
      labels,
      datasets: [{ label: "Count", data }],
    },
    options: {
      indexAxis: "y",
      plugins: {
        legend: { display: false },
        title: { display: true, text: `Воронка откликов (последние ${days} дней)` },
      },
      scales: { x: { beginAtZero: true } },
    },
  };

  return quickChartUrl(config, 900, 520);
}

function trendChartUrl(daily: { date: string; count: number }[], days: number): string {
  const labels = daily.map((d) => d.date);
  const data = daily.map((d) => d.count);

  const config = {
    type: "line",
    data: {
      labels,
      datasets: [{ label: "Отклики/день", data, fill: false, tension: 0.2 }],
    },
    options: {
      plugins: {
        legend: { display: false },
        title: { display: true, text: `Отклики по дням (последние ${days} дней)` },
      },
      scales: { y: { beginAtZero: true } },
    },
  };

  return quickChartUrl(config, 900, 420);
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
    const [cmdRaw, ...args] = text.split(" ");
    const cmd = cmdRaw.toLowerCase();

    switch (cmd) {
      case "/start":
        await sendTelegramMessage(
          env,
          chatId,
          "Привет! Я HH Tracker.\n\n" +
            "Как пользоваться:\n" +
            "1) /new\n" +
            "2) Вставляй копипасту из hh.ru (можно частями)\n" +
            "3) /done — я распарсю и сохраню\n\n" +
            "Команды:\n" +
            "/new — очистить буфер\n" +
            "/done — распарсить и сохранить\n" +
            "/stats [7|30|90] — статистика (по умолчанию 30 дней)\n" +
            "/funnel [7|30|90] — картинка-воронка\n" +
            "/trend [7|30|90] — график откликов по дням\n" +
            "/table [n] — последние n строк таблицей (по умолчанию 15)\n" +
            "/export [7|30|90|all] — CSV-файл\n" +
            "/reset — очистить буфер"
        );
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

        const days = 30;
        const stats = await getUserStats({ DB: env.DB }, userId, days);

        await sendTelegramMessage(
          env,
          chatId,
          `Готово. Добавлено: ${inserted}. Дублей: ${duplicates}.\n\n` +
            `Хочешь в табличном виде — /export или /table.\n` +
            `Обновлённая статистика: /stats`
        );

        // Воронка как картинка (лучше, чем ASCII). Если Telegram не сможет скачать — просто в логах будет ошибка.
        await sendTelegramPhoto(env, chatId, funnelChartUrl(stats.statusBreakdown, days));

        return;
      }

      case "/stats": {
        const days = Math.min(Math.max(parseInt(args[0] || "30", 10) || 30, 1), 365);
        const stats = await getUserStats({ DB: env.DB }, userId, days);
        await sendTelegramMessage(env, chatId, formatStats(stats, days));
        return;
      }

      case "/funnel": {
        const days = Math.min(Math.max(parseInt(args[0] || "30", 10) || 30, 1), 365);
        const stats = await getUserStats({ DB: env.DB }, userId, days);
        await sendTelegramPhoto(env, chatId, funnelChartUrl(stats.statusBreakdown, days));
        return;
      }

      case "/trend": {
        const days = Math.min(Math.max(parseInt(args[0] || "30", 10) || 30, 1), 365);
        const stats = await getUserStats({ DB: env.DB }, userId, days);
        await sendTelegramPhoto(env, chatId, trendChartUrl(stats.dailyActivity, days));
        return;
      }

      case "/table": {
        const n = Math.min(Math.max(parseInt(args[0] || "15", 10) || 15, 1), 50);
        const rows = await listResponses({ DB: env.DB }, userId, { limit: n });
        if (!rows.length) {
          await sendTelegramMessage(env, chatId, "Пока пусто. Добавь отклики через /new → текст → /done.");
          return;
        }
        await sendTelegramMessage(env, chatId, formatTable(rows));
        return;
      }

      case "/export": {
        const arg = (args[0] || "30").toLowerCase();
        const days = arg === "all" ? undefined : Math.min(Math.max(parseInt(arg, 10) || 30, 1), 365);
        const rows = await listResponses({ DB: env.DB }, userId, { days, limit: 5000 });
        if (!rows.length) {
          await sendTelegramMessage(env, chatId, "Пока пусто. Добавь отклики через /new → текст → /done.");
          return;
        }
        const csv = toCsv(rows);
        const suffix = days ? `${days}d` : "all";
        const filename = `hh-responses-${suffix}.csv`;
        await sendTelegramDocument(env, chatId, filename, "text/csv; charset=utf-8", csv);
        return;
      }

      case "/connect": {
        // Sheets отключены — без Google Cloud делать нормально без OAuth нельзя.
        await sendTelegramMessage(
          env,
          chatId,
          "Google Sheets сейчас отключены. Вместо этого используй /export — я пришлю CSV (открывается в Excel/Numbers/Google Sheets)."
        );
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
