import type { ParsedResponse } from "./parser";

export type Env = {
  DB: D1Database;
};

export type UserRow = {
  user_id: number;
  chat_id: number;
  last_ack_at: number;
};

export async function ensureUser(env: Env, userId: number, chatId: number): Promise<UserRow> {
  // UPSERT
  await env.DB.prepare(
    `INSERT INTO users (user_id, chat_id)
     VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id`
  ).bind(userId, chatId).run();

  const row = await env.DB.prepare(
    `SELECT user_id, chat_id, last_ack_at FROM users WHERE user_id = ?`
  ).bind(userId).first<UserRow>();

  // По-хорошему не должно быть null
  return row as UserRow;
}

export async function getBuffer(env: Env, userId: number): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT buffer_text FROM buffers WHERE user_id = ?`
  ).bind(userId).first<{ buffer_text: string }>();
  return row?.buffer_text ?? "";
}

export async function clearBuffer(env: Env, userId: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM buffers WHERE user_id = ?`).bind(userId).run();
}

export async function appendToBuffer(env: Env, userId: number, text: string): Promise<void> {
  const existing = await env.DB.prepare(`SELECT 1 FROM buffers WHERE user_id = ?`).bind(userId).first();
  if (existing) {
    await env.DB.prepare(
      `UPDATE buffers
       SET buffer_text = buffer_text || '\n' || ?, updated_at = datetime('now')
       WHERE user_id = ?`
    ).bind(text, userId).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO buffers (user_id, buffer_text) VALUES (?, ?)`
  ).bind(userId, text).run();
}

export async function updateLastAckAt(env: Env, userId: number, tsMs: number): Promise<void> {
  await env.DB.prepare(`UPDATE users SET last_ack_at = ? WHERE user_id = ?`).bind(tsMs, userId).run();
}

export async function markUpdateProcessed(env: Env, updateId: number): Promise<boolean> {
  const r = await env.DB.prepare(
    `INSERT INTO processed_updates (update_id) VALUES (?)
     ON CONFLICT(update_id) DO NOTHING`
  ).bind(updateId).run();

  // Если meta.changes = 1 => вставилось => новый update
  return (r?.meta?.changes ?? 0) === 1;
}

export async function addResponses(
  env: Env,
  userId: number,
  parsed: ParsedResponse[]
): Promise<{ inserted: number; duplicates: number }> {
  if (parsed.length === 0) return { inserted: 0, duplicates: 0 };

  const stmts = parsed.map((p) =>
    env.DB.prepare(
      `INSERT INTO responses (
        user_id, response_date, company, title, status, role_family, grade, hash, raw
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, hash) DO NOTHING`
    ).bind(
      userId,
      p.responseDate,
      p.company,
      p.title,
      p.status,
      p.roleFamily,
      p.grade,
      p.hash,
      p.raw
    )
  );

  const results = await env.DB.batch(stmts);
  const inserted = results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
  const duplicates = parsed.length - inserted;
  return { inserted, duplicates };
}

export type UserStats = {
  totalResponses: number;
  statusBreakdown: Record<string, number>;
  topCompanies: { name: string; count: number }[];
  dailyActivity: { date: string; count: number }[];
};

export async function getUserStats(env: Env, userId: number, days = 30): Promise<UserStats> {
  // В D1 timestamps по умолчанию идут как SQLite datetime('now') => "YYYY-MM-DD HH:MM:SS".
  // Поэтому фильтруем через SQLite datetime, а не через ISO строки.
  const sinceExpr = `-${days} days`;

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM responses
     WHERE user_id = ? AND imported_at >= datetime('now', ?)`
  ).bind(userId, sinceExpr).first<{ total: number }>();

  const breakdownRes = await env.DB.prepare(
    `SELECT status, COUNT(*) AS count
     FROM responses
     WHERE user_id = ? AND imported_at >= datetime('now', ?)
     GROUP BY status`
  ).bind(userId, sinceExpr).all<{ status: string; count: number }>();

  const statusBreakdown: Record<string, number> = {};
  for (const r of (breakdownRes.results ?? [])) {
    statusBreakdown[r.status] = Number(r.count);
  }

  const topCompaniesRes = await env.DB.prepare(
    `SELECT company AS name, COUNT(*) AS count
     FROM responses
     WHERE user_id = ? AND imported_at >= datetime('now', ?)
     GROUP BY company
     ORDER BY count DESC
     LIMIT 5`
  ).bind(userId, sinceExpr).all<{ name: string; count: number }>();

  const dailyRes = await env.DB.prepare(
    `SELECT strftime('%Y-%m-%d', imported_at) AS date, COUNT(*) AS count
     FROM responses
     WHERE user_id = ? AND imported_at >= datetime('now', ?)
     GROUP BY date
     ORDER BY date`
  ).bind(userId, sinceExpr).all<{ date: string; count: number }>();

  return {
    totalResponses: Number(totalRow?.total ?? 0),
    statusBreakdown,
    topCompanies: (topCompaniesRes.results ?? []).map((r) => ({ name: r.name, count: Number(r.count) })),
    dailyActivity: (dailyRes.results ?? []).map((r) => ({ date: r.date, count: Number(r.count) })),
  };
}

export type Period = "week" | "month" | "all";

function buildPeriodWhere(period: Period) {
  if (period === "all") return { where: "", args: [] as unknown[] };
  const days = period === "week" ? 7 : 30;
  return { where: " AND imported_at >= datetime('now', ?)", args: [`-${days} days`] };
}

export type UserStatsV2 = {
  period: Period;
  total: number;
  status: Record<string, number>;
  grade: Record<string, number>;
  roleFamily: Record<string, number>;
  topCompanies: { name: string; count: number }[];
  interviews: {
    screening: number;
    hr: number;
    technical: number;
    offer: number;
  };
};

async function ensureInterviewEntriesTable(env: Env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS interview_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      screening INTEGER NOT NULL DEFAULT 0,
      hr INTEGER NOT NULL DEFAULT 0,
      technical INTEGER NOT NULL DEFAULT 0,
      offer INTEGER NOT NULL DEFAULT 0
    );
  `).run();

  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_interview_entries_user_created_at
     ON interview_entries(user_id, created_at)`
  ).run();
}

export async function addInterviewEntry(
  env: Env,
  userId: number,
  counts: { screening: number; hr: number; technical: number; offer: number }
) {
  await ensureInterviewEntriesTable(env);
  await env.DB.prepare(
    `INSERT INTO interview_entries (user_id, screening, hr, technical, offer)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(userId, counts.screening, counts.hr, counts.technical, counts.offer)
    .run();
}

export async function getInterviewSums(env: Env, userId: number, period: Period) {
  await ensureInterviewEntriesTable(env);
  const p = buildPeriodWhere(period);
  const row = await env.DB.prepare(
    `SELECT
        COALESCE(SUM(screening), 0) AS screening,
        COALESCE(SUM(hr), 0) AS hr,
        COALESCE(SUM(technical), 0) AS technical,
        COALESCE(SUM(offer), 0) AS offer
     FROM interview_entries
     WHERE user_id = ?${p.where.replaceAll("imported_at", "created_at")}`
  ).bind(userId, ...p.args).first<{ screening: number; hr: number; technical: number; offer: number }>();

  return {
    screening: Number(row?.screening ?? 0),
    hr: Number(row?.hr ?? 0),
    technical: Number(row?.technical ?? 0),
    offer: Number(row?.offer ?? 0),
  };
}

async function ensureUserStateTable(env: Env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_state (
      user_id INTEGER PRIMARY KEY,
      state TEXT NOT NULL,
      data TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `).run();
}

export type UserStateRow = {
  user_id: number;
  state: string;
  data: string | null;
  updated_at: string;
};

export async function getUserState(env: Env, userId: number): Promise<UserStateRow | null> {
  await ensureUserStateTable(env);
  const row = await env.DB.prepare(
    `SELECT user_id, state, data, updated_at FROM user_state WHERE user_id = ?`
  ).bind(userId).first<UserStateRow>();
  return row ?? null;
}

export async function setUserState(env: Env, userId: number, state: string, data?: unknown) {
  await ensureUserStateTable(env);
  const json = data == null ? null : JSON.stringify(data);
  await env.DB.prepare(
    `INSERT INTO user_state (user_id, state, data, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       state = excluded.state,
       data = excluded.data,
       updated_at = excluded.updated_at`
  ).bind(userId, state, json).run();
}

export async function clearUserState(env: Env, userId: number) {
  await ensureUserStateTable(env);
  await env.DB.prepare(`DELETE FROM user_state WHERE user_id = ?`).bind(userId).run();
}

export async function getUserStatsV2(env: Env, userId: number, period: Period): Promise<UserStatsV2> {
  const p = buildPeriodWhere(period);

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM responses
     WHERE user_id = ?${p.where}`
  ).bind(userId, ...p.args).first<{ total: number }>();

  const statusRes = await env.DB.prepare(
    `SELECT status, COUNT(*) AS count
     FROM responses
     WHERE user_id = ?${p.where}
     GROUP BY status`
  ).bind(userId, ...p.args).all<{ status: string; count: number }>();

  const gradeRes = await env.DB.prepare(
    `SELECT grade, COUNT(*) AS count
     FROM responses
     WHERE user_id = ?${p.where}
     GROUP BY grade`
  ).bind(userId, ...p.args).all<{ grade: string; count: number }>();

  const roleRes = await env.DB.prepare(
    `SELECT role_family AS role, COUNT(*) AS count
     FROM responses
     WHERE user_id = ?${p.where}
     GROUP BY role_family`
  ).bind(userId, ...p.args).all<{ role: string; count: number }>();

  const topCompaniesRes = await env.DB.prepare(
    `SELECT company AS name, COUNT(*) AS count
     FROM responses
     WHERE user_id = ?${p.where}
     GROUP BY company
     ORDER BY count DESC
     LIMIT 8`
  ).bind(userId, ...p.args).all<{ name: string; count: number }>();

  const status: Record<string, number> = {};
  for (const r of statusRes.results ?? []) status[r.status] = Number(r.count);

  const grade: Record<string, number> = {};
  for (const r of gradeRes.results ?? []) grade[r.grade] = Number(r.count);

  const roleFamily: Record<string, number> = {};
  for (const r of roleRes.results ?? []) roleFamily[r.role] = Number(r.count);

  const interviews = await getInterviewSums(env, userId, period);

  return {
    period,
    total: Number(totalRow?.total ?? 0),
    status,
    grade,
    roleFamily,
    topCompanies: (topCompaniesRes.results ?? []).map((r) => ({ name: r.name, count: Number(r.count) })),
    interviews,
  };
}

export type ResponseRow = {
  imported_at: string;
  response_date: string | null;
  company: string;
  title: string;
  status: string;
  role_family: string;
  grade: string;
  raw: string;
};

export async function listUserResponses(env: Env, userId: number, period: Period): Promise<ResponseRow[]> {
  const p = buildPeriodWhere(period);
  const res = await env.DB.prepare(
    `SELECT imported_at, response_date, company, title, status, role_family, grade, raw
     FROM responses
     WHERE user_id = ?${p.where}
     ORDER BY imported_at DESC`
  ).bind(userId, ...p.args).all<ResponseRow>();
  return (res.results ?? []) as ResponseRow[];
}


export type CompanyEnrichmentRow = {
  company: string;
  domain: string | null;
  industry: string | null;
  employees: number | null;
  size_bucket: "S" | "M" | "L" | "XL" | null;
  source: "clearbit" | "wikidata" | "none";
  updated_at: string;
};

async function ensureCompanyEnrichmentTable(env: Env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS company_enrichment (
      company TEXT PRIMARY KEY,
      domain TEXT,
      industry TEXT,
      employees INTEGER,
      size_bucket TEXT,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `).run();
}

export async function getCompanyEnrichment(env: Env, company: string) {
  await ensureCompanyEnrichmentTable(env);
  return await env.DB.prepare(
    `SELECT company, domain, industry, employees, size_bucket, source, updated_at
     FROM company_enrichment
     WHERE company = ?`
  ).bind(company).first<CompanyEnrichmentRow>();
}

export async function upsertCompanyEnrichment(
  env: Env,
  data: {
    company: string;
    domain?: string | null;
    industry?: string | null;
    employees?: number | null;
    size_bucket?: string | null;
    source: string;
  }
) {
  await ensureCompanyEnrichmentTable(env);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO company_enrichment (company, domain, industry, employees, size_bucket, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(company) DO UPDATE SET
       domain = excluded.domain,
       industry = excluded.industry,
       employees = excluded.employees,
       size_bucket = excluded.size_bucket,
       source = excluded.source,
       updated_at = excluded.updated_at`
  )
    .bind(
      data.company,
      data.domain ?? null,
      data.industry ?? null,
      data.employees ?? null,
      data.size_bucket ?? null,
      data.source,
      now
    )
    .run();
}

export async function listUserCompanies(env: Env, userId: number, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const res = await env.DB.prepare(
    `SELECT DISTINCT company
     FROM responses
     WHERE user_id = ? AND imported_at >= ?
     ORDER BY company`
  ).bind(userId, since).all<{ company: string }>();
  return (res.results ?? []).map((r) => r.company);
}
