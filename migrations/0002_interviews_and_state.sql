-- Вручную добавляемые собеседования (скрининг / HR / техничка / оффер)
CREATE TABLE IF NOT EXISTS interview_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  screening INTEGER NOT NULL DEFAULT 0,
  hr INTEGER NOT NULL DEFAULT 0,
  technical INTEGER NOT NULL DEFAULT 0,
  offer INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_interview_entries_user_created_at
  ON interview_entries(user_id, created_at);

-- Простое состояние для пошаговых сценариев в боте (например ввод собесов)
CREATE TABLE IF NOT EXISTS user_state (
  user_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  data TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
