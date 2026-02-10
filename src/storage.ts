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
): Promise<{ inserted: number; duplicates: number; insertedRows: ParsedResponse[] }> {
  if (parsed.length === 0) return { inserted: 0, duplicates: 0, insertedRows: [] };

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

  const insertedRows: ParsedResponse[] = [];
  for (let i = 0; i < results.length; i++) {
    if ((results[i].meta?.changes ?? 0) === 1) insertedRows.push(parsed[i]);
  }

  return { inserted, duplicates, insertedRows };
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


export type UserSheetRow = {
  user_id: number;
  email: string;
  spreadsheet_id: string;
  created_at: string;
  updated_at: string;
};

async function ensureUserSheetsTable(env: Env): Promise<void> {
  // Само-инициализация схемы, чтобы не заставлять тебя вручную гонять миграции.
  // Безопасно: CREATE TABLE IF NOT EXISTS.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS user_sheets (
      user_id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      spreadsheet_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run();

  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_user_sheets_email ON user_sheets(email)`
  ).run();
}

export async function getUserSheet(env: Env, userId: number): Promise<UserSheetRow | null> {
  await ensureUserSheetsTable(env);
  const row = await env.DB.prepare(
    `SELECT user_id, email, spreadsheet_id, created_at, updated_at
     FROM user_sheets WHERE user_id = ?`
  ).bind(userId).first<UserSheetRow>();
  return (row as UserSheetRow) ?? null;
}

export async function upsertUserSheet(
  env: Env,
  userId: number,
  email: string,
  spreadsheetId: string
): Promise<void> {
  await ensureUserSheetsTable(env);
  await env.DB.prepare(
    `INSERT INTO user_sheets (user_id, email, spreadsheet_id)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE
       SET email = excluded.email,
           spreadsheet_id = excluded.spreadsheet_id,
           updated_at = datetime('now')`
  ).bind(userId, email, spreadsheetId).run();
}

export async function clearUserSheet(env: Env, userId: number): Promise<void> {
  await ensureUserSheetsTable(env);
  await env.DB.prepare(`DELETE FROM user_sheets WHERE user_id = ?`).bind(userId).run();
}

export type ResponseRow = {
  response_date: string | null;
  company: string;
  title: string;
  status: string;
  role_family: string;
  grade: string;
};

export async function listUserResponses(env: Env, userId: number, limit = 2000): Promise<ResponseRow[]> {
  const res = await env.DB.prepare(
    `SELECT response_date, company, title, status, role_family, grade
     FROM responses
     WHERE user_id = ?
     ORDER BY imported_at ASC
     LIMIT ?`
  ).bind(userId, limit).all<ResponseRow>();

  return (res.results ?? []) as ResponseRow[];
}
