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
  getCompanyEnrichment,
  markUpdateProcessed,
  updateLastAckAt,
} from "./storage";
import { sendTelegramMessage, sendTelegramDocument, sendTelegramPhoto } from "./telegram";
import { enrichCompanies } from "./enrich";

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



function pad(str: string, n: number): string {
  const s = (str ?? "").toString();
  if (s.length >= n) return s.slice(0, n - 1) + "…";
  return s + " ".repeat(n - s.length);
}

function fmtDate(d?: string | null): string {
  if (!d) return "—";
  // если уже YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  // оставим как есть (hh может давать "Сегодня" и т.п.)
  return d;
}

async function buildTableText(env: Env, userId: number, days: number | null, limit: number): Promise<string> {
  const rows = await listResponses({ DB: env.DB }, userId, days, limit, 0);
  if (!rows.length) return "Пока пусто.";

  const header =
    pad("Date", 10) + " " +
    pad("Company", 18) + " " +
    pad("Title", 24) + " " +
    pad("Status", 14) + " " +
    pad("Role", 10) + " " +
    pad("Grade", 8) + " " +
    pad("Size", 4);

  const sep = "-".repeat(header.length);

  const lines: string[] = [header, sep];

  for (const r of rows) {
    const key = (r.company ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    const enr = key ? await getCompanyEnrichment({ DB: env.DB }, key) : null;

    lines.push(
      pad(fmtDate(r.response_date), 10) + " " +
        pad(r.company ?? "—", 18) + " " +
        pad(r.title ?? "—", 24) + " " +
        pad(r.status ?? "—", 14) + " " +
        pad(r.role_family ?? "—", 10) + " " +
        pad(r.grade ?? "—", 8) + " " +
        pad(enr?.size_bucket ?? "—", 4)
    );
  }

  return "```\n" + lines.join("\n") + "\n```";
}

function csvEscape(v: any): string {
  const s = (v ?? "").toString();
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function buildCsv(env: Env, userId: number, days: number | null, limit: number): Promise<string> {
  const rows = await listResponses({ DB: env.DB }, userId, days, limit, 0);
  const header = [
    "response_date",
    "company",
    "title",
    "status",
    "role_family",
    "grade",
    "domain",
    "industry",
    "employees",
    "size_bucket",
    "source",
    "imported_at",
  ].join(",");

  const out: string[] = [header];

  for (const r of rows) {
    const key = (r.company ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    const enr = key ? await getCompanyEnrichment({ DB: env.DB }, key) : null;

    out.push(
      [
        fmtDate(r.response_date),
        r.company ?? "",
        r.title ?? "",
        r.status ?? "",
        r.role_family ?? "",
        r.grade ?? "",
        enr?.domain ?? "",
        enr?.industry ?? "",
        enr?.employees ?? "",
        enr?.size_bucket ?? "",
        enr?.source ?? "",
        r.imported_at ?? "",
      ].map(csvEscape).join(",")
    );
  }

  return out.join("\n");
}

function quickchartUrl(config: any): string {
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}`;
}

function funnelOrder() {
  // под твои статусы
  return ["Не просмотрен", "Просмотрен", "Тестовое", "Приглашение", "Собеседование", "Отказ"];
}

async function buildFunnelChartUrl(env: Env, userId: number, days: number): Promise<string> {
  const stats = await getUserStats({ DB: env.DB }, userId, days);
  const order = funnelOrder();
  const labels = order;
  const values = labels.map((l) => stats.statusBreakdown[l] ?? 0);

  const cfg = {
    type: "bar",
    data: {
      labels,
      datasets: [{ label: `Отклики за ${days} дней`, data: values }],
    },
    options: {
      legend: { display: false },
      title: { display: true, text: "Воронка по статусам" },
      scales: { xAxes: [{ ticks: { beginAtZero: true } }] },
    },
  };

  return quickchartUrl(cfg);
}

async function buildTrendChartUrl(env: Env, userId: number, days: number): Promise<string> {
  const stats = await getUserStats({ DB: env.DB }, userId, days);
  const labels = stats.dailyActivity.map((d) => d.date);
  const values = stats.dailyActivity.map((d) => d.count);

  const cfg = {
    type: "line",
    data: {
      labels,
      datasets: [{ label: "Отклики", data: values, fill: false }],
    },
    options: {
      title: { display: true, text: "Отклики по дням" },
      scales: { yAxes: [{ ticks: { beginAtZero: true, precision: 0 } }] },
    },
  };

  return quickchartUrl(cfg);
}

async function processUpdate(env: Env, update: TelegramUpdate, ctx?: ExecutionContext) {
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
          "/table 10 — последние записи\n" +
          "/export 30|all — CSV выгрузка\n" +
          "/funnel 30 — воронка по статусам\n" +
          "/trend 30 — отклики по дням\n" +
          "/enrich 30|all — обновить enrichment\n" +
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

        // enrichment компаний (в фоне, не мешает пользователю)
        ctx?.waitUntil(enrichCompanies({ DB: env.DB }, parsed.map((p) => p.company)));

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

      case "/table": {
        const n = Number(args[0] ?? "10");
        const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 30) : 10;
        const text = await buildTableText(env, userId, 30, limit);
        await sendTelegramMessage(env, chatId, text);
        return;
      }

      case "/export": {
        const a = (args[0] ?? "30").toLowerCase();
        const days = a === "all" ? null : Math.max(1, Number(a) || 30);
        const limit = a === "all" ? 5000 : 5000;
        const csv = await buildCsv(env, userId, days, limit);
        const suffix = days ? `${days}d` : "all";
        await sendTelegramDocument(env, chatId, `hh-responses-${suffix}.csv`, csv, "CSV выгрузка");
        return;
      }

      case "/funnel": {
        const days = Math.max(1, Number(args[0] ?? "30") || 30);
        const url = await buildFunnelChartUrl(env, userId, days);
        await sendTelegramPhoto(env, chatId, url);
        return;
      }

      case "/trend": {
        const days = Math.max(1, Number(args[0] ?? "30") || 30);
        const url = await buildTrendChartUrl(env, userId, days);
        await sendTelegramPhoto(env, chatId, url);
        return;
      }

      case "/enrich": {
        // форс-обогащение компаний за 30 дней (или all)
        const a = (args[0] ?? "30").toLowerCase();
        const days = a === "all" ? null : Math.max(1, Number(a) || 30);
        const rows = await listResponses({ DB: env.DB }, userId, days, 5000, 0);
        const companies = rows.map((r) => r.company ?? "").filter(Boolean);
        ctx?.waitUntil(enrichCompanies({ DB: env.DB }, companies, true));
        await sendTelegramMessage(env, chatId, "Ок. Запустил enrichment в фоне. Через минуту повтори /table или /export.");
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
    processUpdate(c.env, update, c.executionCtx).catch(async (e) => {
      console.log("processUpdate error", e);
      const chatId = update?.message?.chat?.id;
      if (chatId) {
        await sendTelegramMessage(c.env, chatId, "Ошибка при обработке. Попробуй ещё раз или /start.");
      }
    })
  );

  return c.json({ ok: true });
});

export default { fetch: app.fetch };