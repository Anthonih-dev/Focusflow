const Database = require('better-sqlite3');
const path = require('path');

class DB {
  constructor(dbPath) {
    const file = dbPath || process.env.DATABASE_PATH || path.join(process.cwd(), 'focusflow.sqlite');
    this.db = new Database(file);
    this._init();
    this._prepareStatements();
  }

  _init() {
    const sql = `
    CREATE TABLE IF NOT EXISTS users (
      chat_id TEXT PRIMARY KEY,
      default_cooldown INTEGER DEFAULT NULL,
      alerts_enabled INTEGER DEFAULT 1,
      autoremove INTEGER DEFAULT 0,
      risk_size REAL DEFAULT NULL,
      risk_percent REAL DEFAULT NULL,
      risk_points REAL DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      type TEXT NOT NULL,
      params TEXT,
      enabled INTEGER DEFAULT 1,
      last_type TEXT,
      last_price REAL,
      last_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(chat_id) REFERENCES users(chat_id)
    );
    `;
    this.db.exec(sql);
    // migration: add default_cooldown/autoremove/risk columns if missing
    const cols = this.db.prepare("PRAGMA table_info(users)").all().map(c=>c.name);
    if (!cols.includes('default_cooldown')) {
      this.db.exec('ALTER TABLE users ADD COLUMN default_cooldown INTEGER DEFAULT NULL');
    }
    if (!cols.includes('autoremove')) {
      this.db.exec('ALTER TABLE users ADD COLUMN autoremove INTEGER DEFAULT 0');
    }
    if (!cols.includes('risk_size')) {
      this.db.exec('ALTER TABLE users ADD COLUMN risk_size REAL DEFAULT NULL');
      this.db.exec('ALTER TABLE users ADD COLUMN risk_percent REAL DEFAULT NULL');
      this.db.exec('ALTER TABLE users ADD COLUMN risk_points REAL DEFAULT NULL');
    }
  }

  _prepareStatements() {
    this.stmts = {
      getUser: this.db.prepare('SELECT * FROM users WHERE chat_id = ?'),
      upsertUser: this.db.prepare(`INSERT INTO users (chat_id, default_cooldown, alerts_enabled, autoremove, risk_size, risk_percent, risk_points)
        VALUES (@chat_id, @default_cooldown, @alerts_enabled, @autoremove, @risk_size, @risk_percent, @risk_points)
        ON CONFLICT(chat_id) DO UPDATE SET
          default_cooldown = COALESCE(excluded.default_cooldown, users.default_cooldown),
          alerts_enabled = excluded.alerts_enabled,
          autoremove = COALESCE(excluded.autoremove, users.autoremove),
          risk_size = COALESCE(excluded.risk_size, users.risk_size),
          risk_percent = COALESCE(excluded.risk_percent, users.risk_percent),
          risk_points = COALESCE(excluded.risk_points, users.risk_points)`),
      addAlert: this.db.prepare('INSERT INTO alerts (chat_id, symbol, type, params) VALUES (?, ?, ?, ?)'),
      listAlerts: this.db.prepare('SELECT * FROM alerts WHERE chat_id = ?'),
      deleteAlert: this.db.prepare('DELETE FROM alerts WHERE id = ? AND chat_id = ?'),
      clearSymbol: this.db.prepare('DELETE FROM alerts WHERE chat_id = ? AND symbol = ?'),
      toggleAlert: this.db.prepare('UPDATE alerts SET enabled = ? WHERE id = ? AND chat_id = ?'),
      updateAlertState: this.db.prepare('UPDATE alerts SET last_type = ?, last_price = ?, last_at = ? WHERE id = ?'),
      getEnabledAlerts: this.db.prepare('SELECT * FROM alerts WHERE enabled = 1'),
      // legacy user helpers (not used in new alert model)
      usersBySymbol: this.db.prepare('SELECT * FROM users WHERE chat_id = ?')
    };
  }

  getUser(chatId) {
    return this.stmts.getUser.get(String(chatId));
  }

  setUserCooldown(chatId, cd) {
    return this.stmts.upsertUser.run({ chat_id: String(chatId), default_cooldown: cd, alerts_enabled: 1 });
  }

  setAutoRemove(chatId, enabled) {
    return this.db.prepare('UPDATE users SET autoremove = ? WHERE chat_id = ?').run(enabled ? 1 : 0, String(chatId));
  }

  setRiskParams(chatId, size, percent, points) {
    return this.db.prepare('UPDATE users SET risk_size = ?, risk_percent = ?, risk_points = ? WHERE chat_id = ?')
      .run(size, percent, points, String(chatId));
  }

  addAlert(chatId, symbol, type, params) {
    return this.stmts.addAlert.run(String(chatId), String(symbol), String(type), JSON.stringify(params || {}));
  }

  listAlerts(chatId) {
    return this.stmts.listAlerts.all(String(chatId));
  }

  deleteAlert(chatId, id) {
    return this.stmts.deleteAlert.run(id, String(chatId));
  }

  clearAlertsForSymbol(chatId, symbol) {
    return this.stmts.clearSymbol.run(String(chatId), String(symbol));
  }

  toggleAlert(chatId, id, enabled) {
    return this.stmts.toggleAlert.run(enabled ? 1 : 0, id, String(chatId));
  }

  updateAlertState(id, type, price, ts = Math.floor(Date.now()/1000)) {
    return this.stmts.updateAlertState.run(type, price, ts, id);
  }

  getEnabledAlerts() {
    return this.stmts.getEnabledAlerts.all();
  }

  upsertUser(record) {
    const row = {
      chat_id: String(record.chat_id),
      symbol: record.symbol || null,
      threshold: record.threshold === undefined ? null : record.threshold,
      cooldown: record.cooldown === undefined ? null : record.cooldown,
      alerts_enabled: record.alerts_enabled ? 1 : 0,
      last_alert_type: record.last_alert_type || null,
      last_alert_price: record.last_alert_price || null,
      last_alert_at: record.last_alert_at || null
    };
    return this.stmts.upsertUser.run(row);
  }

  setSymbol(chatId, symbol) {
    return this.stmts.setSymbol.run(String(chatId), String(symbol));
  }

  setThreshold(chatId, threshold) {
    return this.stmts.setThreshold.run(String(chatId), Number(threshold));
  }

  setCooldown(chatId, seconds) {
    return this.stmts.setCooldown.run(String(chatId), Number(seconds));
  }

  setAlertsEnabled(chatId, enabled) {
    return this.stmts.setAlertsEnabled.run(String(chatId), enabled ? 1 : 0);
  }

  // *** legacy helpers (unused) remain below ***
  setSymbol(chatId, symbol) {
    return this.stmts.setSymbol.run(String(chatId), String(symbol));
  }


  updateLastAlert(chatId, type, price, ts = Math.floor(Date.now() / 1000)) {
    return this.stmts.updateLastAlert.run(type, price, ts, String(chatId));
  }


  getAllUsers() {
    return this.stmts.allUsers.all();
  }

  shouldSendAlert(user) {
    const now = Math.floor(Date.now() / 1000);
    const cooldown = (user.cooldown != null) ? Number(user.cooldown) : Number(process.env.DEFAULT_ALERT_COOLDOWN || 300);
    if (!user.last_alert_at) return true;
    return (now - Number(user.last_alert_at)) >= cooldown;
  }
}

module.exports = DB;