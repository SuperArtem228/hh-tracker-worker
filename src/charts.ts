import type { Period, UserStatsV2 } from "./storage";

// Генерация картинок без Python: через QuickChart (Chart.js).
// Это внешний сервис. Он бесплатный для простых задач и избавляет от запуска питона у пользователя.

export function periodTitle(period: Period): string {
  if (period === "week") return "7 дней";
  if (period === "month") return "30 дней";
  return "всё время";
}

function qcUrl(config: unknown, width = 900, height = 520): string {
  const c = encodeURIComponent(JSON.stringify(config));
  // backgroundColor=white делает PNG читабельным в Telegram
  return `https://quickchart.io/chart?format=png&backgroundColor=white&width=${width}&height=${height}&c=${c}`;
}

const STATUS_ORDER = ["Не просмотрен", "Просмотрен", "Тестовое", "Приглашение", "Собеседование", "Отказ"];

export function buildFullFunnelChart(stats: UserStatsV2) {
  const labels: string[] = ["Отклики", "Приглашение", "Собеседование", "Скрининг", "HR", "Техничка", "Оффер"];
  const data: number[] = [
    stats.total,
    Number(stats.status["Приглашение"] ?? 0),
    Number(stats.status["Собеседование"] ?? 0),
    stats.interviews.screening,
    stats.interviews.hr,
    stats.interviews.technical,
    stats.interviews.offer,
  ];

  const config = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "",
          data,
        },
      ],
    },
    options: {
      indexAxis: "y",
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: `Воронка (отклики + собесы) (${periodTitle(stats.period)})`,
        },
      },
      scales: {
        x: { beginAtZero: true },
      },
    },
  };

  return qcUrl(config);
}

export function buildStatusFunnelChart(stats: UserStatsV2) {
  const labels: string[] = [];
  const data: number[] = [];

  for (const s of STATUS_ORDER) {
    if (stats.status[s] != null) {
      labels.push(s);
      data.push(stats.status[s]);
    }
  }

  // добавим редкие статусы в конец
  for (const [k, v] of Object.entries(stats.status)) {
    if (STATUS_ORDER.includes(k)) continue;
    labels.push(k);
    data.push(v);
  }

  const config = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Отклики",
          data,
        },
      ],
    },
    options: {
      indexAxis: "y",
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: `Воронка по статусам (${periodTitle(stats.period)})`,
        },
      },
      scales: {
        x: { beginAtZero: true },
      },
    },
  };

  return qcUrl(config);
}

export function buildGradePieChart(stats: UserStatsV2) {
  const mapping: Record<string, string> = {
    junior: "Junior",
    middle: "Middle",
    senior: "Senior",
  };

  const labels = Object.keys(mapping).filter((k) => stats.grade[k] != null).map((k) => mapping[k]);
  const data = Object.keys(mapping).filter((k) => stats.grade[k] != null).map((k) => stats.grade[k]);

  const config = {
    type: "pie",
    data: {
      labels,
      datasets: [{ data }],
    },
    options: {
      plugins: {
        legend: { position: "right" },
        title: {
          display: true,
          text: `Грейды (${periodTitle(stats.period)})`,
        },
      },
    },
  };

  return qcUrl(config, 900, 520);
}

export function buildRolePieChart(stats: UserStatsV2) {
  const mapping: Record<string, string> = {
    product: "Product",
    project: "Project",
    product_marketing: "Product Marketing",
    product_analytics: "Product Analytics",
    other: "Other",
  };

  const labels = Object.keys(mapping)
    .filter((k) => stats.roleFamily[k] != null)
    .map((k) => mapping[k]);
  const data = Object.keys(mapping)
    .filter((k) => stats.roleFamily[k] != null)
    .map((k) => stats.roleFamily[k]);

  const config = {
    type: "pie",
    data: {
      labels,
      datasets: [{ data }],
    },
    options: {
      plugins: {
        legend: { position: "right" },
        title: {
          display: true,
          text: `Роли (${periodTitle(stats.period)})`,
        },
      },
    },
  };

  return qcUrl(config, 900, 520);
}
