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

  const row = await env.DB.prepare(`SELECT user_id, chat_id, last_ack_at FROM users WHERE user_id = ?`)
    .bind(userId)
    .first<UserRow>();

  // По-хорошему не должно быть null
  return row as UserRow;
}

export async function getBuffer(env: Env, userId: number): Promise<string> {
  const row = await env.DB.prepare(`SELECT buffer_text FROM buffers WHERE user_id = ?`)
    .bind(userId)
    .first<{ buffer_text: string }>();
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
  await env.DB.prepare(`INSERT INTO buffers (user_id, buffer_text) VALUES (?, ?)`).bind(userId, text).run();
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
    ).bind(userId, p.responseDate, p.company, p.title, p.status, p.roleFamily, p.grade, p.hash, p.raw)
  );

  const results = await env.DB.batch(stmts);
  const inserted = results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
  const duplicates = parsed.length - inserted;
  return { inserted, duplicates };
}

export type ResponseRow = {
  response_date: string | null;
  company: string;
  title: string;
  status: string;
  role_family: string;
  grade: string;
  imported_at: string;
};

function isoSinceDays(days: number): string {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return since.toISOString();
}

export async function listResponses(
  env: Env,
  userId: number,
  opts?: { days?: number; limit?: number }
): Promise<ResponseRow[]> {
  const days = opts?.days;
  const limit = Math.min(Math.max(opts?.limit ?? 5000, 1), 5000);

  if (days && Number.isFinite(days) && days > 0) {
    const since = isoSinceDays(days);
    const res = await env.DB.prepare(
      `SELECT response_date, company, title, status, role_family, grade, imported_at
       FROM responses
       WHERE user_id = ? AND imported_at >= ?
       ORDER BY imported_at DESC
       LIMIT ?`
    ).bind(userId, since, limit).all<ResponseRow>();
    return (res.results ?? []) as ResponseRow[];
  }

  const res = await env.DB.prepare(
    `SELECT response_date, company, title, status, role_family, grade, imported_at
     FROM responses
     WHERE user_id = ?
     ORDER BY imported_at DESC
     LIMIT ?`
  ).bind(userId, limit).all<ResponseRow>();

  return (res.results ?? []) as ResponseRow[];
}

export type UserStats = {
  totalResponses: number;
  statusBreakdown: Record<string, number>;
  roleBreakdown: Record<string, number>;
  gradeBreakdown: Record<string, number>;
  dailyActivity: { date: string; count: number }[];
  weeklyActivity: { week: string; count: number }[];
};

export async function getUserStats(env: Env, userId: number, days = 30): Promise<UserStats> {
  const since = isoSinceDays(days);

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

  const roleRes = await env.DB.prepare(
    `SELECT role_family AS role, COUNT(*) AS count
     FROM responses
     WHERE user_id = ? AND imported_at >= ?
     GROUP BY role_family`
  ).bind(userId, since).all<{ role: string; count: number }>();

  const roleBreakdown: Record<string, number> = {};
  for (const r of (roleRes.results ?? [])) {
    roleBreakdown[r.role] = Number(r.count);
  }

  const gradeRes = await env.DB.prepare(
    `SELECT grade, COUNT(*) AS count
     FROM responses
     WHERE user_id = ? AND imported_at >= ?
     GROUP BY grade`
  ).bind(userId, since).all<{ grade: string; count: number }>();

  const gradeBreakdown: Record<string, number> = {};
  for (const r of (gradeRes.results ?? [])) {
    gradeBreakdown[r.grade] = Number(r.count);
  }

  const dailyRes = await env.DB.prepare(
    `SELECT strftime('%Y-%m-%d', imported_at) AS date, COUNT(*) AS count
     FROM responses
     WHERE user_id = ? AND imported_at >= ?
     GROUP BY date
     ORDER BY date`
  ).bind(userId, since).all<{ date: string; count: number }>();

  const weeklyRes = await env.DB.prepare(
    `SELECT strftime('%Y-W%W', imported_at) AS week, COUNT(*) AS count
     FROM responses
     WHERE user_id = ? AND imported_at >= ?
     GROUP BY week
     ORDER BY week`
  ).bind(userId, since).all<{ week: string; count: number }>();

  return {
    totalResponses: Number(totalRow?.total ?? 0),
    statusBreakdown,
    roleBreakdown,
    gradeBreakdown,
    dailyActivity: (dailyRes.results ?? []).map((r) => ({ date: r.date, count: Number(r.count) })),
    weeklyActivity: (weeklyRes.results ?? []).map((r) => ({ week: r.week, count: Number(r.count) })),
  };
}
