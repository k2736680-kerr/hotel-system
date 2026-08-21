const fs = require('fs')
const path = require('path')
const initSqlJs = require('sql.js')

const SCHEMA_VERSION = 4

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'ADMIN' CHECK (role IN ('ADMIN', 'FRONT_DESK', 'FINANCE')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_session (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  standard_price_cents INTEGER NOT NULL DEFAULT 0 CHECK (standard_price_cents >= 0),
  default_capacity INTEGER NOT NULL DEFAULT 1 CHECK (default_capacity >= 1),
  max_capacity INTEGER NOT NULL DEFAULT 2 CHECK (max_capacity >= default_capacity),
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_no TEXT NOT NULL COLLATE NOCASE UNIQUE,
  room_type_id INTEGER NOT NULL REFERENCES room_types(id),
  floor TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  cleaning_status TEXT NOT NULL DEFAULT 'CLEAN' CHECK (cleaning_status IN ('CLEAN', 'DIRTY')),
  maintenance_status TEXT NOT NULL DEFAULT 'NORMAL' CHECK (maintenance_status IN ('NORMAL', 'MAINTENANCE')),
  maintenance_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  document_type TEXT NOT NULL DEFAULT 'ID_CARD',
  document_no TEXT NOT NULL COLLATE NOCASE,
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  blacklisted INTEGER NOT NULL DEFAULT 0 CHECK (blacklisted IN (0, 1)),
  blacklist_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(document_type, document_no)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'WALK_IN',
  contact_name TEXT NOT NULL,
  contact_phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('RESERVED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW')),
  expected_checkin TEXT NOT NULL,
  expected_checkout TEXT NOT NULL,
  actual_checkin TEXT,
  actual_checkout TEXT,
  notes TEXT NOT NULL DEFAULT '',
  same_day_rate_mode TEXT NOT NULL DEFAULT 'NEW' CHECK (same_day_rate_mode IN ('OLD', 'NEW')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  room_type_id INTEGER NOT NULL REFERENCES room_types(id),
  nightly_rate_cents INTEGER NOT NULL CHECK (nightly_rate_cents >= 0),
  expected_checkin TEXT NOT NULL,
  expected_checkout TEXT NOT NULL,
  actual_checkin TEXT,
  actual_checkout TEXT,
  status TEXT NOT NULL CHECK (status IN ('RESERVED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stay_guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_room_id INTEGER NOT NULL REFERENCES order_rooms(id),
  guest_id INTEGER NOT NULL REFERENCES guests(id),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  registered_at TEXT NOT NULL,
  UNIQUE(order_room_id, guest_id)
);

CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  order_room_id INTEGER REFERENCES order_rooms(id),
  type TEXT NOT NULL CHECK (type IN ('ROOM', 'SERVICE', 'DAMAGE', 'DISCOUNT', 'ADJUSTMENT')),
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'MANUAL',
  voided INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0, 1)),
  void_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  direction TEXT NOT NULL CHECK (direction IN ('RECEIPT', 'REFUND')),
  purpose TEXT NOT NULL CHECK (purpose IN ('ROOM', 'DEPOSIT', 'OTHER')),
  method TEXT NOT NULL CHECK (method IN ('CASH', 'WECHAT', 'ALIPAY', 'CARD', 'OTHER')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  notes TEXT NOT NULL DEFAULT '',
  original_payment_id INTEGER REFERENCES payments(id),
  voided INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  operator_name TEXT NOT NULL DEFAULT '系统',
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rooms_type ON rooms(room_type_id);
CREATE INDEX IF NOT EXISTS idx_guests_name ON guests(name);
CREATE INDEX IF NOT EXISTS idx_guests_phone ON guests(phone);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_dates ON orders(expected_checkin, expected_checkout);
CREATE INDEX IF NOT EXISTS idx_order_rooms_room_dates ON order_rooms(room_id, expected_checkin, expected_checkout, status);
CREATE INDEX IF NOT EXISTS idx_charges_order ON charges(order_id, voided);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id, voided);
CREATE INDEX IF NOT EXISTS idx_operation_logs_created ON operation_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_operation_logs_action ON operation_logs(action);
`

function nowIso() {
  return new Date().toISOString()
}

class HotelDatabase {
  constructor(SQL, filePath, database) {
    this.SQL = SQL
    this.filePath = filePath
    this.db = database
  }

  static async open(filePath) {
    const SQL = await initSqlJs({
      locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
    })
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const recoveryPath = `${filePath}.previous`
    if (!fs.existsSync(filePath) && fs.existsSync(recoveryPath)) fs.renameSync(recoveryPath, filePath)
    if (fs.existsSync(filePath) && fs.existsSync(recoveryPath)) fs.rmSync(recoveryPath)
    const bytes = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null
    const db = bytes?.length ? new SQL.Database(bytes) : new SQL.Database()
    const instance = new HotelDatabase(SQL, filePath, db)
    instance.migrate()
    return instance
  }

  migrate() {
    this.db.exec(SCHEMA_SQL)
    const applied = this.get('SELECT MAX(version) AS version FROM schema_migrations')?.version || 0
    const orderColumns = this.all('PRAGMA table_info(orders)').map((column) => column.name)
    if (!orderColumns.includes('same_day_rate_mode')) {
      this.db.exec("ALTER TABLE orders ADD COLUMN same_day_rate_mode TEXT NOT NULL DEFAULT 'NEW' CHECK (same_day_rate_mode IN ('OLD', 'NEW'))")
    }
    const logColumns = this.all('PRAGMA table_info(operation_logs)').map((column) => column.name)
    if (!logColumns.includes('operator_name')) {
      this.db.exec("ALTER TABLE operation_logs ADD COLUMN operator_name TEXT NOT NULL DEFAULT '系统'")
    }
    if (applied < SCHEMA_VERSION) {
      this.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', [SCHEMA_VERSION, nowIso()])
    }
    this.seedDefaults()
    this.persist()
  }

  seedDefaults() {
    const count = this.get('SELECT COUNT(*) AS count FROM room_types').count
    if (count > 0) return
    const now = nowIso()
    this.run(`INSERT INTO room_types
      (name, standard_price_cents, default_capacity, max_capacity, description, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['标准间', 18800, 1, 2, '', 10, now, now])
    this.run(`INSERT INTO room_types
      (name, standard_price_cents, default_capacity, max_capacity, description, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['大床房', 26800, 1, 2, '', 20, now, now])
  }

  all(sql, params = []) {
    const statement = this.db.prepare(sql)
    try {
      statement.bind(params)
      const rows = []
      while (statement.step()) rows.push(statement.getAsObject())
      return rows
    } finally {
      statement.free()
    }
  }

  get(sql, params = []) {
    return this.all(sql, params)[0] || null
  }

  run(sql, params = []) {
    this.db.run(sql, params)
    return {
      id: this.get('SELECT last_insert_rowid() AS id').id,
      changes: this.db.getRowsModified()
    }
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE TRANSACTION')
    try {
      const result = work()
      this.db.exec('COMMIT')
      this.persist()
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (_) {}
      throw error
    }
  }

  persist() {
    const bytes = Buffer.from(this.db.export())
    const temporaryPath = `${this.filePath}.tmp`
    const recoveryPath = `${this.filePath}.previous`
    fs.writeFileSync(temporaryPath, bytes)
    if (fs.existsSync(recoveryPath)) fs.rmSync(recoveryPath)
    if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, recoveryPath)
    try {
      fs.renameSync(temporaryPath, this.filePath)
      if (fs.existsSync(recoveryPath)) fs.rmSync(recoveryPath)
    } catch (error) {
      if (!fs.existsSync(this.filePath) && fs.existsSync(recoveryPath)) fs.renameSync(recoveryPath, this.filePath)
      throw error
    }
  }

  backupTo(targetPath) {
    this.persist()
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.copyFileSync(this.filePath, targetPath)
    return targetPath
  }

  validateDatabaseFile(sourcePath) {
    const bytes = fs.readFileSync(sourcePath)
    const candidate = new this.SQL.Database(bytes)
    try {
      const result = candidate.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      if (!result.length || !result[0].values.length) throw new Error('备份文件缺少数据库结构')
      const check = candidate.exec('PRAGMA integrity_check')
      if (check[0]?.values?.[0]?.[0] !== 'ok') throw new Error('备份文件完整性检查失败')
      const foreignKeys = candidate.exec('PRAGMA foreign_key_check')
      if (foreignKeys[0]?.values?.length) throw new Error('备份文件存在关联数据错误')
    } finally {
      candidate.close()
    }
  }

  restoreFrom(sourcePath, safetyBackupPath) {
    this.validateDatabaseFile(sourcePath)
    this.backupTo(safetyBackupPath)
    const bytes = fs.readFileSync(sourcePath)
    const replacement = new this.SQL.Database(bytes)
    replacement.exec('PRAGMA foreign_keys = ON')
    this.db.close()
    this.db = replacement
    try {
      this.migrate()
    } catch (error) {
      this.db.close()
      this.db = new this.SQL.Database(fs.readFileSync(safetyBackupPath))
      this.db.exec('PRAGMA foreign_keys = ON')
      this.persist()
      throw error
    }
    return safetyBackupPath
  }

  close() {
    if (!this.db) return
    this.persist()
    this.db.close()
    this.db = null
  }
}

module.exports = { HotelDatabase, SCHEMA_VERSION }
