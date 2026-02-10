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
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM responses
     WHERE user_id = ? AND imported_at >= ?`
  ).bind(userId, since).first<{ total: number }>();

  const breakdownRes = await env.DB.prepare(
    `SELECT status, COUNT(*) AS count
     FROM responses
     WHERE user_id = ? AND imported_at >= ?
     GROUP BY status`
  ).bind(userId, since).all<{ status: string; count: number }>();

  const statusBreakdown: Record<string, number> = {};
  for (const r of (breakdownRes.results ?? [])) {
    statusBreakdown[r.status] = Number(r.count);
  }

  const topCompaniesRes = await env.DB.prepare(
    `SELECT company AS name, COUNT(*) AS count
     FROM responses
     WHERE user_id = ? AND imported_at >= ?
     GROUP BY company
     ORDER BY count DESC
     LIMIT 5`
  ).bind(userId, since).all<{ name: string; count: number }>();

  const dailyRes = await env.DB.prepare(
    `SELECT strftime('%Y-%m-%d', imported_at) AS date, COUNT(*) AS count
     FROM responses
     WHERE user_id = ? AND imported_at >= ?
     GROUP BY date
     ORDER BY date`
  ).bind(userId, since).all<{ date: string; count: number }>();

  return {
    totalResponses: Number(totalRow?.total ?? 0),
    statusBreakdown,
    topCompanies: (topCompaniesRes.results ?? []).map((r) => ({ name: r.name, count: Number(r.count) })),
    dailyActivity: (dailyRes.results ?? []).map((r) => ({ date: r.date, count: Number(r.count) })),
  };
}



// ---------- Responses listing (for /table, /export) ----------

export type ResponseRow = {
  id: number;
  response_date: string | null;
  company: string | null;
  title: string | null;
  status: string | null;
  role_family: string | null;
  grade: string | null;
  imported_at: string | null;
};

export async function listResponses(env: Env, userId: number, days: number | null, limit: number, offset = 0): Promise<ResponseRow[]> {
  const whereDays = days ? `AND imported_at >= datetime('now', ?)` : "";
  const params: any[] = [userId];
  if (days) params.push(`-${days} days`);
  params.push(limit, offset);

  const sql = `
    SELECT id, response_date, company, title, status, role_family, grade, imported_at
    FROM responses
    WHERE user_id = ?
    ${whereDays}
    ORDER BY COALESCE(response_date, imported_at) DESC, id DESC
    LIMIT ? OFFSET ?;
  `;

  const res = await env.DB.prepare(sql).bind(...params).all<ResponseRow>();
  return res.results ?? [];
}

// ---------- Company enrichment cache ----------

export type CompanyEnrichmentRow = {
  key: string;
  name: string;
  domain: string | null;
  industry: string | null;
  employees: number | null;
  size_bucket: string | null;
  source: string | null;
  updated_at: string | null;
};

async function ensureCompanyEnrichmentTable(env: Env): Promise<void> {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS company_enrichment (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT,
      industry TEXT,
      employees INTEGER,
      size_bucket TEXT,
      source TEXT,
      updated_at TEXT
    );
  `);
}

export async function getCompanyEnrichment(env: Env, key: string): Promise<CompanyEnrichmentRow | null> {
  await ensureCompanyEnrichmentTable(env);
  const row = await env.DB.prepare(
    `SELECT key, name, domain, industry, employees, size_bucket, source, updated_at
     FROM company_enrichment WHERE key = ?`
  ).bind(key).first<CompanyEnrichmentRow>();
  return row ?? null;
}

export async function upsertCompanyEnrichment(env: Env, key: string, data: { name: string; domain?: any; industry?: any; employees?: any; size_bucket?: any; source?: any; updated_at?: any; }): Promise<void> {
  await ensureCompanyEnrichmentTable(env);
  await env.DB.prepare(
    `INSERT INTO company_enrichment (key, name, domain, industry, employees, size_bucket, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       name=excluded.name,
       domain=excluded.domain,
       industry=excluded.industry,
       employees=excluded.employees,
       size_bucket=excluded.size_bucket,
       source=excluded.source,
       updated_at=excluded.updated_at`
  ).bind(
    key,
    data.name,
    data.domain ?? null,
    data.industry ?? null,
    data.employees ?? null,
    data.size_bucket ?? null,
    data.source ?? null,
    data.updated_at ?? null
  ).run();
}
