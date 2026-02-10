-- Google Sheets mapping per user
CREATE TABLE IF NOT EXISTS user_sheets (
  user_id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  spreadsheet_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_sheets_email
  ON user_sheets(email);
