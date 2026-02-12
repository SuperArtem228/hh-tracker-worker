import { fnv1a64Hex } from "./hash";

export type ParsedResponse = {
  title: string;
  company: string;
  status: string;
  responseDate: string;
  roleFamily: "product" | "project" | "product_marketing" | "product_analytics" | "other";
  grade: "junior" | "middle" | "senior";
  hash: string;
  raw: string;
};

const VALID_STATUSES = new Set([
  "Отказ",
  "Просмотрен",
  "Не просмотрен",
  "Собеседование",
  "Приглашение",
  "Тестовое",
]);

// Строки HH, которые постоянно засоряют копипасту
const IGNORE_SUBSTRINGS = [
  "Employer Logo",
  "Был онлайн",
  "Разбирает",
  "Получите работу быстрее",
  "подпиской hh PRO",
  "доступ к статистике",
];

const MONTHS = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

function isIgnorable(line: string): boolean {
  return IGNORE_SUBSTRINGS.some((s) => line.includes(s));
}

function extractDate(blockLines: string[]): string | null {
  for (const l of blockLines) {
    const line = l.toLowerCase();
    if (line === "сегодня" || line === "вчера") return l;
    const m = line.match(/\b(\d{1,2})\s+([а-яё]+)\b/i);
    if (m && MONTHS.includes(m[2])) return `${m[1]} ${m[2]}`;
  }
  return null;
}

function detectRoleFamily(title: string): ParsedResponse["roleFamily"] {
  const t = title.toLowerCase();

  const hasProduct = /(product|продакт|продукт)/i.test(t) || t.includes("менеджер по продукт");
  const hasProject = /(project|проджект|проект)/i.test(t);
  const hasAnalyst = /(analyst|аналит|analytics|аналитик)/i.test(t);
  const hasMarketing = /(marketing|маркетинг|growth|гроус|performance)/i.test(t);

  // Product Marketing
  if (hasMarketing && (hasProduct || t.includes("product marketing") || t.includes("продакт маркет"))) {
    return "product_marketing";
  }

  // Product Analytics
  if (hasAnalyst && (hasProduct || t.includes("product analyst") || t.includes("продакт аналит"))) {
    return "product_analytics";
  }

  // Project
  if (hasProject) return "project";

  // Product
  if (hasProduct) return "product";

  // Analytics (как категория "Product Analytics" по умолчанию, чтобы не плодить лишние)
  if (hasAnalyst) return "product_analytics";

  return "other";
}

function detectGrade(title: string): ParsedResponse["grade"] {
  const t = title.toLowerCase();
  if (/(junior|джун|младш|intern|стаж)/i.test(t)) return "junior";
  if (/(senior|старш|lead|head|руковод)/i.test(t)) return "senior";
  return "middle";
}

/**
 * Парсит копипасту из hh.ru (раздел "Отклики").
 * Логика:
 * - собираем блок строк до тех пор, пока не встретим строку-статус
 * - в блоке первая "нормальная" строка = title, вторая = company
 * - date ищем по ключевым словам (сегодня/вчера) или "5 февраля"
 */
export function parseHHBuffer(text: string): ParsedResponse[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !isIgnorable(l));

  const out: ParsedResponse[] = [];
  let block: string[] = [];

  const flush = (status: string) => {
    const payload = block.filter((l) => !VALID_STATUSES.has(l));
    const date = extractDate(payload) ?? "Unknown";

    // кандидаты на title/company: убираем строки-даты
    const candidates = payload.filter((l) => {
      const low = l.toLowerCase();
      if (low === "сегодня" || low === "вчера") return false;
      const m = low.match(/\b(\d{1,2})\s+([а-яё]+)\b/i);
      if (m && MONTHS.includes(m[2])) return false;
      return true;
    });

    const title = candidates[0] ?? "Unknown";
    const company = candidates[1] ?? "Unknown";
    const roleFamily = detectRoleFamily(title);
    const grade = detectGrade(title);

    const hash = fnv1a64Hex(`${title}|${company}|${date}|${status}`);
    const raw = [title, company, date, status].join(" | ");

    out.push({ title, company, status, responseDate: date, roleFamily, grade, hash, raw });
  };

  for (const line of lines) {
    if (VALID_STATUSES.has(line)) {
      if (block.length > 0) flush(line);
      block = [];
      continue;
    }
    block.push(line);
  }

  // дедуп внутри одного буфера (если пользователь прислал одно и то же несколькими кусками)
  const seen = new Set<string>();
  const deduped: ParsedResponse[] = [];
  for (const r of out) {
    if (seen.has(r.hash)) continue;
    seen.add(r.hash);
    deduped.push(r);
  }

  return deduped;
}
