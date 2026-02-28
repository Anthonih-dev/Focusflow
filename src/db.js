const Database = require('better-sqlite3');

function createDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      muted INTEGER DEFAULT 0,
      auto_remove INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      type TEXT NOT NULL,
      direction TEXT,
      target_price REAL,
      zone_low REAL,
      zone_high REAL,
      threshold REAL,
      window_seconds INTEGER,
      last_triggered_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_symbol ON alerts(symbol);
    CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_user_symbol ON alerts(telegram_id, symbol);
  `);

  const stmts = {
    upsertUser: db.prepare(`
      INSERT INTO users (telegram_id, username, first_name)
      VALUES (@telegram_id, @username, @first_name)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        updated_at = CURRENT_TIMESTAMP
    `),

    getUser: db.prepare('SELECT * FROM users WHERE telegram_id = ?'),

    setMute: db.prepare('UPDATE users SET muted = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?'),

    setAutoRemove: db.prepare('UPDATE users SET auto_remove = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?'),

    createAlert: db.prepare(`
      INSERT INTO alerts (
        telegram_id, symbol, type, direction, target_price, zone_low, zone_high, threshold, window_seconds
      ) VALUES (
        @telegram_id, @symbol, @type, @direction, @target_price, @zone_low, @zone_high, @threshold, @window_seconds
      )
    `),

    listAlertsByUser: db.prepare('SELECT * FROM alerts WHERE telegram_id = ? ORDER BY created_at DESC'),

    listAlertsBySymbol: db.prepare('SELECT * FROM alerts WHERE symbol = ? ORDER BY created_at ASC'),

    getAlertByIdForUser: db.prepare('SELECT * FROM alerts WHERE id = ? AND telegram_id = ?'),

    deleteAlertByIdForUser: db.prepare('DELETE FROM alerts WHERE id = ? AND telegram_id = ?'),

    clearAlertsForUserSymbol: db.prepare('DELETE FROM alerts WHERE telegram_id = ? AND symbol = ?'),

    clearAlertsForUser: db.prepare('DELETE FROM alerts WHERE telegram_id = ?'),

    deleteAlertById: db.prepare('DELETE FROM alerts WHERE id = ?'),

    touchAlert: db.prepare('UPDATE alerts SET last_triggered_at = CURRENT_TIMESTAMP WHERE id = ?'),

    getAllSymbols: db.prepare('SELECT DISTINCT symbol FROM alerts'),

    countAlertsForSymbol: db.prepare('SELECT COUNT(*) AS count FROM alerts WHERE symbol = ?')
  };

  return { db, stmts };
}

module.exports = { createDb };
