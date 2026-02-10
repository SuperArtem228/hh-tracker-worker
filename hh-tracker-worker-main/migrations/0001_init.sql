-- Users: один Telegram user_id = одна "учётка" в системе
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_ack_at INTEGER NOT NULL DEFAULT 0
);

-- Buffer: накопитель копипасты
CREATE TABLE IF NOT EXISTS buffers (
  user_id INTEGER PRIMARY KEY,
  buffer_text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Parsed responses
CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  response_date TEXT,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  role_family TEXT NOT NULL,
  grade TEXT NOT NULL,
  hash TEXT NOT NULL,
  raw TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_user_hash
  ON responses(user_id, hash);

CREATE INDEX IF NOT EXISTS idx_responses_user_imported_at
  ON responses(user_id, imported_at);

CREATE INDEX IF NOT EXISTS idx_responses_user_status
  ON responses(user_id, status);

CREATE INDEX IF NOT EXISTS idx_responses_user_company
  ON responses(user_id, company);

-- Telegram idempotency: Telegram может прислать один и тот же update_id повторно
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
