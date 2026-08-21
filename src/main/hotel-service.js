const crypto = require('crypto')
const { assert, AppError } = require('./errors')

const PAYMENT_METHODS = new Set(['CASH', 'WECHAT', 'ALIPAY', 'CARD', 'OTHER'])
const CHARGE_TYPES = new Set(['SERVICE', 'DAMAGE', 'DISCOUNT', 'ADJUSTMENT'])

function nowIso() {
  return new Date().toISOString()
}

function text(value) {
  return String(value ?? '').trim()
}

function integer(value, fieldName) {
  const parsed = Number(value)
  assert(Number.isSafeInteger(parsed), 'INVALID_FIELD', `${fieldName}格式不正确`)
  return parsed
}

function positiveId(value, fieldName = '记录') {
  const parsed = integer(value, fieldName)
  assert(parsed > 0, 'INVALID_FIELD', `${fieldName}不存在`)
  return parsed
}

function cents(value, fieldName, options = {}) {
  const parsed = integer(value, fieldName)
  const minimum = options.allowZero ? 0 : 1
  assert(parsed >= minimum, 'INVALID_AMOUNT', `${fieldName}必须${options.allowZero ? '大于或等于' : '大于'}0`)
  return parsed
}

function isoDate(value, fieldName) {
  const date = value ? new Date(value) : new Date()
  assert(!Number.isNaN(date.getTime()), 'INVALID_DATE', `${fieldName}格式不正确`)
  return date.toISOString()
}

function dateKey(value) {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function enumerateNights(checkin, checkout) {
  const start = new Date(checkin)
  const end = new Date(checkout)
  const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())
  const endDay = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate())
  const nightCount = Math.max(1, Math.ceil((endDay - startDay) / 86400000))
  return Array.from({ length: nightCount }, (_, index) => {
    const day = new Date(startDay + index * 86400000)
    return `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`
  })
}

function orderNumber(date = new Date()) {
  const pad = (value, size = 2) => String(value).padStart(size, '0')
  return `HT${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(Math.floor(Math.random() * 1000), 3)}`
}

function isValidChineseIdCard(value) {
  if (!/^\d{17}[\dX]$/i.test(value)) return false
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
  const sum = weights.reduce((total, weight, index) => total + Number(value[index]) * weight, 0)
  return checks[sum % 11] === value[17].toUpperCase()
}

function normalizeGuestInput(input) {
  const name = text(input.name)
  const documentType = text(input.documentType) || 'ID_CARD'
  const documentNo = text(input.documentNo).toUpperCase()
  const phone = text(input.phone)
  const blacklisted = Boolean(input.blacklisted)
  const blacklistReason = blacklisted ? text(input.blacklistReason) : ''
  assert(name, 'REQUIRED_FIELD', '客户姓名不能为空')
  assert(documentNo, 'REQUIRED_FIELD', '证件号码不能为空')
  assert(['ID_CARD', 'PASSPORT', 'OTHER'].includes(documentType), 'INVALID_FIELD', '证件类型不正确')
  if (documentType === 'ID_CARD') assert(isValidChineseIdCard(documentNo), 'INVALID_DOCUMENT', '居民身份证号码格式或校验位不正确')
  if (phone) assert(/^[0-9+()\-\s]{6,30}$/.test(phone), 'INVALID_PHONE', '手机号码格式不正确')
  if (blacklisted) assert(blacklistReason, 'REQUIRED_FIELD', '请填写黑名单原因')
  return {
    name, documentType, documentNo, phone,
    address: text(input.address), notes: text(input.notes), blacklisted, blacklistReason
  }
}

class HotelService {
  constructor(database) {
    this.database = database
    this.currentUser = this.restoreSession()
    this.failedLoginAttempts = 0
    this.loginLockedUntil = 0
  }

  restoreSession() {
    const session = this.database.get(`SELECT u.id, u.username, u.display_name, u.role
      FROM auth_session s
      JOIN users u ON u.id = s.user_id
      WHERE s.singleton_id = 1 AND u.enabled = 1`)
    if (session) {
      return { id: session.id, username: session.username, displayName: session.display_name, role: session.role }
    }
    const staleSession = this.database.get('SELECT user_id FROM auth_session WHERE singleton_id = 1')
    if (staleSession) {
      this.database.transaction(() => {
        this.database.run('DELETE FROM auth_session WHERE singleton_id = 1')
      })
    }
    return null
  }

  persistCurrentSession() {
    assert(this.currentUser?.id, 'AUTH_REQUIRED', '请先登录')
    const stamp = nowIso()
    this.database.run('DELETE FROM auth_session WHERE singleton_id = 1')
    this.database.run(
      'INSERT INTO auth_session(singleton_id, user_id, created_at, updated_at) VALUES (1, ?, ?, ?)',
      [this.currentUser.id, stamp, stamp]
    )
  }

  log(action, entityType, entityId, summary) {
    this.database.run(
      'INSERT INTO operation_logs(action, entity_type, entity_id, operator_name, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [action, entityType, entityId || null, this.currentUser?.displayName || '系统', summary, nowIso()]
    )
  }

  getAuthStatus() {
    const userCount = this.database.get('SELECT COUNT(*) AS count FROM users').count
    return {
      needsSetup: userCount === 0,
      authenticated: Boolean(this.currentUser),
      user: this.currentUser
    }
  }

  validateAccountInput(input) {
    const username = text(input.username)
    const displayName = text(input.displayName) || username
    const password = String(input.password || '')
    assert(/^[A-Za-z0-9_]{3,30}$/.test(username), 'INVALID_USERNAME', '账号只能使用3-30位字母、数字或下划线')
    assert(displayName.length >= 1 && displayName.length <= 30, 'INVALID_FIELD', '显示名称长度应为1-30个字符')
    assert(password.length >= 8 && password.length <= 72, 'WEAK_PASSWORD', '密码长度必须为8-72位')
    assert(/[A-Za-z]/.test(password) && /\d/.test(password), 'WEAK_PASSWORD', '密码必须同时包含字母和数字')
    return { username, displayName, password }
  }

  hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') }
  }

  registerAdmin(input) {
    assert(this.database.get('SELECT COUNT(*) AS count FROM users').count === 0, 'SETUP_COMPLETED', '管理员账号已经创建')
    const account = this.validateAccountInput(input)
    const password = this.hashPassword(account.password)
    return this.database.transaction(() => {
      const result = this.database.run(`INSERT INTO users
        (username, display_name, password_salt, password_hash, role, enabled, created_at, last_login_at)
        VALUES (?, ?, ?, ?, 'ADMIN', 1, ?, ?)`,
      [account.username, account.displayName, password.salt, password.hash, nowIso(), nowIso()])
      this.currentUser = { id: result.id, username: account.username, displayName: account.displayName, role: 'ADMIN' }
      this.persistCurrentSession()
      this.log('REGISTER_ADMIN', 'USER', result.id, `创建管理员账号：${account.username}`)
      return this.getAuthStatus()
    })
  }

  login(input) {
    if (Date.now() < this.loginLockedUntil) {
      const seconds = Math.ceil((this.loginLockedUntil - Date.now()) / 1000)
      throw new AppError('LOGIN_LOCKED', `登录失败次数过多，请在${seconds}秒后重试`)
    }
    const username = text(input.username)
    const password = String(input.password || '')
    const user = this.database.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND enabled = 1', [username])
    let valid = false
    if (user) {
      const actual = Buffer.from(this.hashPassword(password, user.password_salt).hash, 'hex')
      const expected = Buffer.from(user.password_hash, 'hex')
      valid = actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
    }
    if (!valid) {
      this.failedLoginAttempts += 1
      if (this.failedLoginAttempts >= 5) {
        this.loginLockedUntil = Date.now() + 5 * 60 * 1000
        this.failedLoginAttempts = 0
      }
      throw new AppError('LOGIN_FAILED', '账号或密码不正确')
    }
    this.failedLoginAttempts = 0
    this.loginLockedUntil = 0
    this.currentUser = { id: user.id, username: user.username, displayName: user.display_name, role: user.role }
    this.database.transaction(() => {
      this.database.run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), user.id])
      this.persistCurrentSession()
      this.log('LOGIN', 'USER', user.id, `账号登录：${user.username}`)
    })
    return this.getAuthStatus()
  }

  requireAuthenticated() {
    assert(this.currentUser, 'AUTH_REQUIRED', '请先登录')
    const active = this.database.get('SELECT id FROM users WHERE id = ? AND enabled = 1', [this.currentUser.id])
    assert(active, 'AUTH_REQUIRED', '登录状态已失效，请重新登录')
    return this.currentUser
  }

  logout(writeLog = true) {
    const currentUser = this.currentUser
    this.database.transaction(() => {
      if (writeLog && currentUser) this.log('LOGOUT', 'USER', currentUser.id, `账号退出：${currentUser.username}`)
      this.database.run('DELETE FROM auth_session WHERE singleton_id = 1')
    })
    this.currentUser = null
    return this.getAuthStatus()
  }

  updateProfile(input) {
    const user = this.requireAuthenticated()
    const displayName = text(input.displayName)
    assert(displayName.length >= 1 && displayName.length <= 30, 'INVALID_FIELD', '显示名称长度应为1-30个字符')
    return this.database.transaction(() => {
      this.database.run('UPDATE users SET display_name = ? WHERE id = ?', [displayName, user.id])
      this.currentUser = { ...this.currentUser, displayName }
      this.persistCurrentSession()
      this.log('UPDATE_PROFILE', 'USER', user.id, `修改显示名称：${displayName}`)
      return this.getAuthStatus()
    })
  }

  changePassword(input) {
    const user = this.requireAuthenticated()
    const currentPassword = String(input.currentPassword || '')
    const nextPassword = String(input.newPassword || '')
    const stored = this.database.get('SELECT * FROM users WHERE id = ?', [user.id])
    const actual = Buffer.from(this.hashPassword(currentPassword, stored.password_salt).hash, 'hex')
    const expected = Buffer.from(stored.password_hash, 'hex')
    assert(actual.length === expected.length && crypto.timingSafeEqual(actual, expected), 'LOGIN_FAILED', '当前密码不正确')
    this.validateAccountInput({ username: stored.username, displayName: stored.display_name, password: nextPassword })
    const next = this.hashPassword(nextPassword)
    return this.database.transaction(() => {
      this.database.run('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?', [next.salt, next.hash, user.id])
      this.persistCurrentSession()
      this.log('CHANGE_PASSWORD', 'USER', user.id, '修改登录密码')
      return { changed: true }
    })
  }

  getDashboard() {
    const rooms = this.listRooms()
    const counts = { total: rooms.length, vacant: 0, occupied: 0, reserved: 0, dirty: 0, maintenance: 0, disabled: 0 }
    for (const room of rooms) {
      if (room.display_status === 'VACANT') counts.vacant += 1
      if (room.display_status === 'OCCUPIED') counts.occupied += 1
      if (room.display_status === 'RESERVED') counts.reserved += 1
      if (room.display_status === 'DIRTY') counts.dirty += 1
      if (room.display_status === 'MAINTENANCE') counts.maintenance += 1
      if (room.display_status === 'DISABLED') counts.disabled += 1
    }
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const tomorrowStart = new Date(todayStart)
    tomorrowStart.setDate(tomorrowStart.getDate() + 1)
    const payments = this.database.get(`SELECT
      COALESCE(SUM(CASE WHEN direction = 'RECEIPT' THEN amount_cents ELSE 0 END), 0) AS receipts,
      COALESCE(SUM(CASE WHEN direction = 'REFUND' THEN amount_cents ELSE 0 END), 0) AS refunds
      FROM payments WHERE voided = 0 AND created_at >= ? AND created_at < ?`, [todayStart.toISOString(), tomorrowStart.toISOString()])
    return {
      counts,
      todayReceiptsCents: payments.receipts,
      todayRefundsCents: payments.refunds,
      todayNetCents: payments.receipts - payments.refunds,
      rooms
    }
  }

  listRoomTypes(includeDisabled = true) {
    const where = includeDisabled ? '' : 'WHERE enabled = 1'
    return this.database.all(`SELECT * FROM room_types ${where} ORDER BY sort_order, name`)
  }

  saveRoomType(input) {
    const id = input.id ? positiveId(input.id, '房型') : null
    const name = text(input.name)
    assert(name, 'REQUIRED_FIELD', '房型名称不能为空')
    const standardPrice = cents(input.standardPriceCents, '标准房价', { allowZero: true })
    const defaultCapacity = integer(input.defaultCapacity, '默认入住人数')
    const maxCapacity = integer(input.maxCapacity, '最大入住人数')
    assert(defaultCapacity >= 1, 'INVALID_FIELD', '默认入住人数至少为1')
    assert(maxCapacity >= defaultCapacity, 'INVALID_FIELD', '最大入住人数不能小于默认入住人数')
    const duplicate = this.database.get('SELECT id FROM room_types WHERE name = ? COLLATE NOCASE AND id <> ?', [name, id || 0])
    assert(!duplicate, 'DUPLICATE_ROOM_TYPE', '房型名称已存在')
    const now = nowIso()

    return this.database.transaction(() => {
      if (id) {
        assert(this.database.get('SELECT id FROM room_types WHERE id = ?', [id]), 'NOT_FOUND', '房型不存在')
        this.database.run(`UPDATE room_types SET name = ?, standard_price_cents = ?, default_capacity = ?,
          max_capacity = ?, description = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
        [name, standardPrice, defaultCapacity, maxCapacity, text(input.description), integer(input.sortOrder || 0, '排序'), now, id])
        this.log('UPDATE', 'ROOM_TYPE', id, `修改房型：${name}`)
        return { id }
      }
      const result = this.database.run(`INSERT INTO room_types
        (name, standard_price_cents, default_capacity, max_capacity, description, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, standardPrice, defaultCapacity, maxCapacity, text(input.description), integer(input.sortOrder || 0, '排序'), now, now])
      this.log('CREATE', 'ROOM_TYPE', result.id, `新增房型：${name}`)
      return { id: result.id }
    })
  }

  toggleRoomType(idValue, enabledValue) {
    const id = positiveId(idValue, '房型')
    const enabled = enabledValue ? 1 : 0
    if (!enabled) {
      const activeRooms = this.database.get('SELECT COUNT(*) AS count FROM rooms WHERE room_type_id = ? AND enabled = 1', [id]).count
      assert(activeRooms === 0, 'ROOM_TYPE_IN_USE', '该房型下仍有启用房间，不能停用')
    }
    return this.database.transaction(() => {
      const result = this.database.run('UPDATE room_types SET enabled = ?, updated_at = ? WHERE id = ?', [enabled, nowIso(), id])
      assert(result.changes === 1, 'NOT_FOUND', '房型不存在')
      this.log(enabled ? 'ENABLE' : 'DISABLE', 'ROOM_TYPE', id, enabled ? '启用房型' : '停用房型')
      return { id, enabled: Boolean(enabled) }
    })
  }

  listRooms() {
    return this.database.all(`SELECT r.*, rt.name AS room_type_name, rt.standard_price_cents,
      CASE
        WHEN r.enabled = 0 THEN 'DISABLED'
        WHEN r.maintenance_status = 'MAINTENANCE' THEN 'MAINTENANCE'
        WHEN EXISTS (SELECT 1 FROM order_rooms x WHERE x.room_id = r.id AND x.status = 'CHECKED_IN') THEN 'OCCUPIED'
        WHEN r.cleaning_status = 'DIRTY' THEN 'DIRTY'
        WHEN EXISTS (SELECT 1 FROM order_rooms x WHERE x.room_id = r.id AND x.status = 'RESERVED'
          AND date(x.expected_checkin, 'localtime') = date('now', 'localtime')) THEN 'RESERVED'
        ELSE 'VACANT'
      END AS display_status,
      (SELECT x.order_id FROM order_rooms x WHERE x.room_id = r.id AND x.status = 'CHECKED_IN' LIMIT 1) AS current_order_id,
      (SELECT o.order_no FROM order_rooms x JOIN orders o ON o.id = x.order_id
        WHERE x.room_id = r.id AND x.status = 'CHECKED_IN' LIMIT 1) AS current_order_no,
      (SELECT o.contact_name FROM order_rooms x JOIN orders o ON o.id = x.order_id
        WHERE x.room_id = r.id AND x.status = 'CHECKED_IN' LIMIT 1) AS current_guest_name
      ,(SELECT x.order_id FROM order_rooms x WHERE x.room_id = r.id AND x.status = 'RESERVED'
        AND date(x.expected_checkin, 'localtime') = date('now', 'localtime') LIMIT 1) AS current_reservation_id
      ,(SELECT o.contact_name FROM order_rooms x JOIN orders o ON o.id = x.order_id
        WHERE x.room_id = r.id AND x.status = 'RESERVED'
        AND date(x.expected_checkin, 'localtime') = date('now', 'localtime') LIMIT 1) AS reservation_guest_name
      FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
      ORDER BY CASE WHEN r.floor = '' THEN 1 ELSE 0 END, r.floor, r.room_no`)
  }

  saveRoom(input) {
    const id = input.id ? positiveId(input.id, '房间') : null
    const roomNo = text(input.roomNo)
    assert(roomNo, 'REQUIRED_FIELD', '房号不能为空')
    const roomTypeId = positiveId(input.roomTypeId, '房型')
    assert(this.database.get('SELECT id FROM room_types WHERE id = ? AND enabled = 1', [roomTypeId]), 'INVALID_ROOM_TYPE', '请选择已启用的房型')
    const duplicate = this.database.get('SELECT id FROM rooms WHERE room_no = ? COLLATE NOCASE AND id <> ?', [roomNo, id || 0])
    assert(!duplicate, 'DUPLICATE_ROOM', '房号已存在')
    const now = nowIso()
    return this.database.transaction(() => {
      if (id) {
        assert(this.database.get('SELECT id FROM rooms WHERE id = ?', [id]), 'NOT_FOUND', '房间不存在')
        this.database.run('UPDATE rooms SET room_no = ?, room_type_id = ?, floor = ?, notes = ?, updated_at = ? WHERE id = ?',
          [roomNo, roomTypeId, text(input.floor), text(input.notes), now, id])
        this.log('UPDATE', 'ROOM', id, `修改房间：${roomNo}`)
        return { id }
      }
      const result = this.database.run(`INSERT INTO rooms
        (room_no, room_type_id, floor, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [roomNo, roomTypeId, text(input.floor), text(input.notes), now, now])
      this.log('CREATE', 'ROOM', result.id, `新增房间：${roomNo}`)
      return { id: result.id }
    })
  }

  toggleRoom(idValue, enabledValue) {
    const id = positiveId(idValue, '房间')
    const enabled = enabledValue ? 1 : 0
    const room = this.database.get('SELECT * FROM rooms WHERE id = ?', [id])
    assert(room, 'NOT_FOUND', '房间不存在')
    if (!enabled) {
      const active = this.database.get("SELECT id FROM order_rooms WHERE room_id = ? AND status IN ('RESERVED', 'CHECKED_IN') LIMIT 1", [id])
      assert(!active, 'ROOM_IN_USE', '房间存在有效订单，不能停用')
    }
    return this.database.transaction(() => {
      this.database.run('UPDATE rooms SET enabled = ?, updated_at = ? WHERE id = ?', [enabled, nowIso(), id])
      this.log(enabled ? 'ENABLE' : 'DISABLE', 'ROOM', id, `${enabled ? '启用' : '停用'}房间 ${room.room_no}`)
      return { id, enabled: Boolean(enabled) }
    })
  }

  markRoomClean(idValue) {
    const id = positiveId(idValue, '房间')
    const room = this.database.get('SELECT * FROM rooms WHERE id = ?', [id])
    assert(room, 'NOT_FOUND', '房间不存在')
    assert(room.cleaning_status === 'DIRTY', 'INVALID_ROOM_STATE', '房间当前不需要清洁确认')
    assert(room.maintenance_status === 'NORMAL', 'INVALID_ROOM_STATE', '维修中的房间不能标记为空闲')
    return this.database.transaction(() => {
      this.database.run("UPDATE rooms SET cleaning_status = 'CLEAN', updated_at = ? WHERE id = ?", [nowIso(), id])
      this.log('MARK_CLEAN', 'ROOM', id, `房间 ${room.room_no} 已清洁`)
      return { id }
    })
  }

  setRoomMaintenance(idValue, enabledValue, reasonValue) {
    const id = positiveId(idValue, '房间')
    const enabled = Boolean(enabledValue)
    const room = this.database.get('SELECT * FROM rooms WHERE id = ?', [id])
    assert(room, 'NOT_FOUND', '房间不存在')
    if (enabled) {
      const active = this.database.get("SELECT id FROM order_rooms WHERE room_id = ? AND status IN ('RESERVED', 'CHECKED_IN') LIMIT 1", [id])
      assert(!active, 'ROOM_OCCUPIED', '房间存在预订或入住订单，请先处理订单后再报修')
      assert(text(reasonValue), 'REQUIRED_FIELD', '请填写报修原因')
    }
    return this.database.transaction(() => {
      this.database.run(`UPDATE rooms SET maintenance_status = ?, maintenance_reason = ?,
        cleaning_status = CASE WHEN ? = 'NORMAL' THEN 'DIRTY' ELSE cleaning_status END, updated_at = ? WHERE id = ?`,
      [enabled ? 'MAINTENANCE' : 'NORMAL', enabled ? text(reasonValue) : '', enabled ? 'MAINTENANCE' : 'NORMAL', nowIso(), id])
      this.log(enabled ? 'START_MAINTENANCE' : 'END_MAINTENANCE', 'ROOM', id,
        enabled ? `房间 ${room.room_no} 报修：${text(reasonValue)}` : `房间 ${room.room_no} 结束维修`)
      return { id }
    })
  }

  listGuests(keywordValue = '') {
    const keyword = text(keywordValue)
    if (!keyword) return this.database.all('SELECT * FROM guests ORDER BY updated_at DESC LIMIT 500')
    const pattern = `%${keyword}%`
    return this.database.all(`SELECT * FROM guests WHERE name LIKE ? OR phone LIKE ? OR document_no LIKE ?
      ORDER BY updated_at DESC LIMIT 500`, [pattern, pattern, pattern])
  }

  listGuestsForExport() {
    return this.database.all('SELECT * FROM guests ORDER BY created_at, id')
  }

  recordGuestExport(count) {
    return this.database.transaction(() => {
      this.log('EXPORT', 'GUEST', null, `导出客户档案：${Number(count) || 0} 条`)
      return { count: Number(count) || 0 }
    })
  }

  importGuests(rows) {
    assert(Array.isArray(rows), 'INVALID_FIELD', '客户导入数据格式不正确')
    assert(rows.length > 0, 'INVALID_FIELD', '导入表格没有客户数据')
    assert(rows.length <= 5000, 'INVALID_FIELD', '单次最多导入 5000 条客户档案')
    const existing = new Set(this.database.all('SELECT document_type, document_no FROM guests')
      .map((row) => `${row.document_type}\u0000${String(row.document_no).toUpperCase()}`))
    const accepted = []
    const errors = []
    let skipped = 0
    rows.forEach((row, index) => {
      try {
        const guest = normalizeGuestInput(row)
        const key = `${guest.documentType}\u0000${guest.documentNo}`
        if (existing.has(key)) {
          skipped += 1
          return
        }
        existing.add(key)
        accepted.push(guest)
      } catch (error) {
        errors.push({ row: index + 2, message: error.message || '数据格式不正确' })
      }
    })
    if (accepted.length) {
      const now = nowIso()
      this.database.transaction(() => {
        accepted.forEach((guest) => this.database.run(`INSERT INTO guests
          (name, document_type, document_no, phone, address, notes, blacklisted, blacklist_reason, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [guest.name, guest.documentType, guest.documentNo, guest.phone, guest.address, guest.notes,
          guest.blacklisted ? 1 : 0, guest.blacklistReason, now, now]))
        this.log('IMPORT', 'GUEST', null, `导入客户档案：成功 ${accepted.length} 条，跳过 ${skipped} 条，错误 ${errors.length} 条`)
      })
    }
    return { imported: accepted.length, skipped, failed: errors.length, errors: errors.slice(0, 50) }
  }

  saveGuest(input) {
    const id = input.id ? positiveId(input.id, '客户') : null
    const guest = normalizeGuestInput(input)
    const { name, documentType, documentNo, phone } = guest
    const duplicate = this.database.get(`SELECT id FROM guests WHERE document_type = ? AND document_no = ? COLLATE NOCASE AND id <> ?`,
      [documentType, documentNo, id || 0])
    assert(!duplicate, 'DUPLICATE_GUEST', '该证件已登记，请直接使用已有客户')
    const now = nowIso()
    return this.database.transaction(() => {
      if (id) {
        assert(this.database.get('SELECT id FROM guests WHERE id = ?', [id]), 'NOT_FOUND', '客户不存在')
        this.database.run(`UPDATE guests SET name = ?, document_type = ?, document_no = ?, phone = ?, address = ?,
          notes = ?, blacklisted = ?, blacklist_reason = ?, updated_at = ? WHERE id = ?`,
        [name, documentType, documentNo, phone, guest.address, guest.notes, guest.blacklisted ? 1 : 0,
          guest.blacklistReason, now, id])
        this.log('UPDATE', 'GUEST', id, `修改客户：${name}`)
        return { id }
      }
      const result = this.database.run(`INSERT INTO guests
        (name, document_type, document_no, phone, address, notes, blacklisted, blacklist_reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, documentType, documentNo, phone, guest.address, guest.notes, guest.blacklisted ? 1 : 0,
        guest.blacklistReason, now, now])
      this.log('CREATE', 'GUEST', result.id, `新增客户：${name}`)
      return { id: result.id }
    })
  }

  assertRoomAvailable(roomId, checkin, checkout, options = {}) {
    const room = this.database.get(`SELECT r.*, rt.name AS room_type_name, rt.max_capacity, rt.standard_price_cents
      FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id WHERE r.id = ?`, [roomId])
    assert(room, 'NOT_FOUND', '房间不存在')
    assert(room.enabled === 1, 'ROOM_UNAVAILABLE', '房间已停用')
    assert(room.maintenance_status === 'NORMAL', 'ROOM_UNAVAILABLE', '房间正在维修')
    if (options.requireClean !== false) assert(room.cleaning_status === 'CLEAN', 'ROOM_UNAVAILABLE', '房间尚未清洁')
    const conflict = this.database.get(`SELECT o.order_no FROM order_rooms x JOIN orders o ON o.id = x.order_id
      WHERE x.room_id = ? AND x.status IN ('RESERVED', 'CHECKED_IN') AND x.order_id <> ?
      AND ? < x.expected_checkout AND ? > x.expected_checkin LIMIT 1`,
    [roomId, options.excludeOrderId || 0, checkin, checkout])
    assert(!conflict, 'ROOM_CONFLICT', conflict ? `房间与订单 ${conflict.order_no} 时间冲突` : '房间时间冲突')
    return room
  }

  getOrder(orderIdValue) {
    const orderId = positiveId(orderIdValue, '订单')
    const order = this.database.get('SELECT * FROM orders WHERE id = ?', [orderId])
    assert(order, 'NOT_FOUND', '订单不存在')
    return order
  }

  getCurrentOrderRoom(orderIdValue) {
    const orderId = positiveId(orderIdValue, '订单')
    return this.database.get(`SELECT x.*, r.room_no, r.cleaning_status, rt.name AS room_type_name,
      rt.max_capacity, rt.standard_price_cents FROM order_rooms x
      JOIN rooms r ON r.id = x.room_id JOIN room_types rt ON rt.id = x.room_type_id
      WHERE x.order_id = ? ORDER BY CASE x.status WHEN 'CHECKED_IN' THEN 1 WHEN 'RESERVED' THEN 2 ELSE 3 END, x.id DESC LIMIT 1`, [orderId])
  }

  calculateRoomChargeRows(orderIdValue, checkoutAtValue = null, rateMode = null) {
    const orderId = positiveId(orderIdValue, '订单')
    const effectiveRateMode = rateMode || this.database.get('SELECT same_day_rate_mode FROM orders WHERE id = ?', [orderId])?.same_day_rate_mode || 'NEW'
    const checkoutAt = checkoutAtValue ? isoDate(checkoutAtValue, '退房时间') : null
    const segments = this.database.all(`SELECT x.*, r.room_no FROM order_rooms x JOIN rooms r ON r.id = x.room_id
      WHERE x.order_id = ? AND x.status <> 'CANCELLED' ORDER BY COALESCE(x.actual_checkin, x.expected_checkin), x.id`, [orderId])
    const byDate = new Map()
    for (const segment of segments) {
      const checkin = segment.actual_checkin || segment.expected_checkin
      let checkout = segment.actual_checkout || segment.expected_checkout
      if (checkoutAt && segment.status === 'CHECKED_IN') checkout = checkoutAt
      if (!checkin || !checkout || new Date(checkout) < new Date(checkin)) continue
      for (const businessDate of enumerateNights(checkin, checkout)) {
        const row = {
          orderRoomId: segment.id,
          businessDate,
          roomNo: segment.room_no,
          nightlyRateCents: segment.nightly_rate_cents,
          description: `${businessDate} 房费（${segment.room_no}）`
        }
        if (!byDate.has(businessDate) || effectiveRateMode === 'NEW') byDate.set(businessDate, row)
      }
    }
    return [...byDate.values()].sort((a, b) => a.businessDate.localeCompare(b.businessDate))
  }

  rebuildAutoRoomCharges(orderIdValue, checkoutAtValue = null, rateMode = null) {
    const orderId = positiveId(orderIdValue, '订单')
    const rows = this.calculateRoomChargeRows(orderId, checkoutAtValue, rateMode)
    this.database.run(`UPDATE charges SET voided = 1, void_reason = '住宿日期或房间发生变更后重算'
      WHERE order_id = ? AND source = 'AUTO_ROOM' AND voided = 0`, [orderId])
    const createdAt = nowIso()
    for (const row of rows) {
      this.database.run(`INSERT INTO charges
        (order_id, order_room_id, type, description, quantity, unit_price_cents, amount_cents, business_date, source, created_at)
        VALUES (?, ?, 'ROOM', ?, 1, ?, ?, ?, 'AUTO_ROOM', ?)`,
      [orderId, row.orderRoomId, row.description, row.nightlyRateCents, row.nightlyRateCents, row.businessDate, createdAt])
    }
    return rows
  }

  createOrder(input, status) {
    const roomId = positiveId(input.roomId, '房间')
    const guestId = positiveId(input.guestId, '客户')
    const checkin = isoDate(status === 'CHECKED_IN' ? input.actualCheckin : input.expectedCheckin, status === 'CHECKED_IN' ? '入住时间' : '预计到店时间')
    const checkout = isoDate(input.expectedCheckout, '预计离店时间')
    assert(new Date(checkout) > new Date(checkin), 'INVALID_DATE_RANGE', '预计离店时间必须晚于到店时间')
    const room = this.assertRoomAvailable(roomId, checkin, checkout, { requireClean: status === 'CHECKED_IN' })
    const guest = this.database.get('SELECT * FROM guests WHERE id = ?', [guestId])
    assert(guest, 'NOT_FOUND', '客户不存在')
    assert(!guest.blacklisted, 'GUEST_BLACKLISTED', `该客户已列入黑名单：${guest.blacklist_reason || '未填写原因'}`)
    const nightlyRate = cents(input.nightlyRateCents ?? room.standard_price_cents, '成交房价', { allowZero: true })
    const deposit = cents(input.depositCents || 0, '押金', { allowZero: true })
    const paymentMethod = text(input.paymentMethod) || 'CASH'
    if (deposit > 0) assert(PAYMENT_METHODS.has(paymentMethod), 'INVALID_FIELD', '支付方式不正确')
    const now = nowIso()

    return this.database.transaction(() => {
      let orderNo
      for (let attempt = 0; attempt < 5; attempt += 1) {
        orderNo = orderNumber(new Date(checkin))
        if (!this.database.get('SELECT id FROM orders WHERE order_no = ?', [orderNo])) break
      }
      assert(!this.database.get('SELECT id FROM orders WHERE order_no = ?', [orderNo]), 'ORDER_NUMBER_FAILED', '订单号生成失败，请重试')
      const orderResult = this.database.run(`INSERT INTO orders
        (order_no, source, contact_name, contact_phone, status, expected_checkin, expected_checkout,
          actual_checkin, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderNo, status === 'CHECKED_IN' ? 'WALK_IN' : (text(input.source) || 'PHONE'), guest.name, guest.phone,
        status, checkin, checkout, status === 'CHECKED_IN' ? checkin : null, text(input.notes), now, now])
      const orderRoomResult = this.database.run(`INSERT INTO order_rooms
        (order_id, room_id, room_type_id, nightly_rate_cents, expected_checkin, expected_checkout,
          actual_checkin, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderResult.id, roomId, room.room_type_id, nightlyRate, checkin, checkout,
        status === 'CHECKED_IN' ? checkin : null, status, now, now])
      this.database.run(`INSERT INTO stay_guests(order_room_id, guest_id, is_primary, registered_at)
        VALUES (?, ?, 1, ?)`, [orderRoomResult.id, guestId, now])
      if (status === 'CHECKED_IN') this.rebuildAutoRoomCharges(orderResult.id)
      if (deposit > 0) {
        this.database.run(`INSERT INTO payments
          (order_id, direction, purpose, method, amount_cents, notes, created_at)
          VALUES (?, 'RECEIPT', 'DEPOSIT', ?, ?, ?, ?)`,
        [orderResult.id, paymentMethod, deposit, status === 'CHECKED_IN' ? '入住押金' : '预订定金', now])
      }
      this.log(status === 'CHECKED_IN' ? 'CHECK_IN' : 'CREATE_RESERVATION', 'ORDER', orderResult.id,
        `订单 ${orderNo} ${status === 'CHECKED_IN' ? '入住' : '预订'}房间 ${room.room_no}`)
      return { orderId: orderResult.id, orderNo }
    })
  }

  checkIn(input) {
    return this.createOrder(input, 'CHECKED_IN')
  }

  createReservation(input) {
    return this.createOrder(input, 'RESERVED')
  }

  checkInReservation(input) {
    const order = this.getOrder(input.orderId)
    assert(order.status === 'RESERVED', 'INVALID_ORDER_STATE', '只有已预订订单可以办理入住')
    const orderRoom = this.getCurrentOrderRoom(order.id)
    const checkin = isoDate(input.actualCheckin, '入住时间')
    const checkout = input.expectedCheckout ? isoDate(input.expectedCheckout, '预计离店时间') : order.expected_checkout
    assert(new Date(checkout) > new Date(checkin), 'INVALID_DATE_RANGE', '预计离店时间必须晚于入住时间')
    this.assertRoomAvailable(orderRoom.room_id, checkin, checkout, { excludeOrderId: order.id })
    return this.database.transaction(() => {
      const now = nowIso()
      this.database.run(`UPDATE orders SET status = 'CHECKED_IN', actual_checkin = ?, expected_checkout = ?, updated_at = ? WHERE id = ?`,
        [checkin, checkout, now, order.id])
      this.database.run(`UPDATE order_rooms SET status = 'CHECKED_IN', actual_checkin = ?, expected_checkin = ?,
        expected_checkout = ?, updated_at = ? WHERE id = ?`, [checkin, checkin, checkout, now, orderRoom.id])
      this.rebuildAutoRoomCharges(order.id)
      this.log('CHECK_IN_RESERVATION', 'ORDER', order.id, `预订 ${order.order_no} 办理入住，房间 ${orderRoom.room_no}`)
      return { orderId: order.id, orderNo: order.order_no }
    })
  }

  cancelReservation(input) {
    const order = this.getOrder(input.orderId)
    assert(order.status === 'RESERVED', 'INVALID_ORDER_STATE', '只有已预订订单可以取消')
    const reason = text(input.reason)
    assert(reason, 'REQUIRED_FIELD', '请填写取消原因')
    const bill = this.getBill(order.id)
    const refundAmount = Math.max(0, bill.netPaidCents)
    const method = text(input.method) || 'CASH'
    if (refundAmount > 0) assert(PAYMENT_METHODS.has(method), 'INVALID_FIELD', '退款方式不正确')
    return this.database.transaction(() => {
      const now = nowIso()
      if (refundAmount > 0) {
        this.database.run(`INSERT INTO payments
          (order_id, direction, purpose, method, amount_cents, notes, created_at)
          VALUES (?, 'REFUND', 'DEPOSIT', ?, ?, ?, ?)`, [order.id, method, refundAmount, `取消预订退款：${reason}`, now])
      }
      this.database.run("UPDATE orders SET status = 'CANCELLED', notes = notes || ?, updated_at = ? WHERE id = ?",
        [`\n取消原因：${reason}`, now, order.id])
      this.database.run("UPDATE order_rooms SET status = 'CANCELLED', updated_at = ? WHERE order_id = ? AND status = 'RESERVED'", [now, order.id])
      this.log('CANCEL_RESERVATION', 'ORDER', order.id, `取消预订 ${order.order_no}：${reason}`)
      return { orderId: order.id, refundAmountCents: refundAmount }
    })
  }

  listStays(statusValue = '', keywordValue = '') {
    const status = text(statusValue)
    const keyword = text(keywordValue)
    const conditions = []
    const params = []
    if (status) { conditions.push('o.status = ?'); params.push(status) }
    if (keyword) {
      conditions.push('(o.order_no LIKE ? OR o.contact_name LIKE ? OR o.contact_phone LIKE ? OR r.room_no LIKE ?)')
      const pattern = `%${keyword}%`
      params.push(pattern, pattern, pattern, pattern)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    return this.database.all(`SELECT o.*, x.id AS order_room_id, x.room_id, x.nightly_rate_cents,
      r.room_no, rt.name AS room_type_name,
      COALESCE((SELECT SUM(c.amount_cents) FROM charges c WHERE c.order_id = o.id AND c.voided = 0), 0) AS charge_total_cents,
      COALESCE((SELECT SUM(CASE WHEN p.direction = 'RECEIPT' THEN p.amount_cents ELSE -p.amount_cents END)
        FROM payments p WHERE p.order_id = o.id AND p.voided = 0), 0) AS net_paid_cents
      FROM orders o JOIN order_rooms x ON x.id = (
        SELECT y.id FROM order_rooms y WHERE y.order_id = o.id
        ORDER BY CASE y.status WHEN 'CHECKED_IN' THEN 1 WHEN 'RESERVED' THEN 2 ELSE 3 END, y.id DESC LIMIT 1)
      JOIN rooms r ON r.id = x.room_id JOIN room_types rt ON rt.id = x.room_type_id
      ${where} ORDER BY COALESCE(o.actual_checkin, o.expected_checkin) DESC`, params)
  }

  getBill(orderIdValue, checkoutAtValue = null) {
    const order = this.getOrder(orderIdValue)
    const currentRoom = this.getCurrentOrderRoom(order.id)
    assert(currentRoom, 'NOT_FOUND', '订单缺少房间信息')
    const roomChargeRows = order.status === 'RESERVED' ? [] : this.calculateRoomChargeRows(order.id, checkoutAtValue)
    const autoRoomTotal = roomChargeRows.reduce((sum, item) => sum + item.nightlyRateCents, 0)
    const otherCharges = this.database.all(`SELECT * FROM charges WHERE order_id = ? AND voided = 0 AND source <> 'AUTO_ROOM'
      ORDER BY created_at`, [order.id])
    const otherTotal = otherCharges.reduce((sum, item) => sum + item.amount_cents, 0)
    const payments = this.database.all('SELECT * FROM payments WHERE order_id = ? AND voided = 0 ORDER BY created_at', [order.id])
    for (const payment of payments) {
      if (payment.direction !== 'RECEIPT') {
        payment.refundable_cents = 0
        continue
      }
      const linkedRefunds = payments.filter((item) => item.direction === 'REFUND' && item.original_payment_id === payment.id)
        .reduce((sum, item) => sum + item.amount_cents, 0)
      payment.refundable_cents = Math.max(0, payment.amount_cents - linkedRefunds)
    }
    const receiptTotal = payments.filter((item) => item.direction === 'RECEIPT').reduce((sum, item) => sum + item.amount_cents, 0)
    const refundTotal = payments.filter((item) => item.direction === 'REFUND').reduce((sum, item) => sum + item.amount_cents, 0)
    const depositTotal = payments.filter((item) => item.direction === 'RECEIPT' && item.purpose === 'DEPOSIT')
      .reduce((sum, item) => sum + item.amount_cents, 0)
    const guests = this.database.all(`SELECT DISTINCT g.*,
      MAX(sg.is_primary) AS is_primary FROM stay_guests sg JOIN guests g ON g.id = sg.guest_id
      JOIN order_rooms x ON x.id = sg.order_room_id WHERE x.order_id = ? GROUP BY g.id ORDER BY is_primary DESC, g.name`, [order.id])
    const segments = this.database.all(`SELECT x.*, r.room_no, rt.name AS room_type_name FROM order_rooms x
      JOIN rooms r ON r.id = x.room_id JOIN room_types rt ON rt.id = x.room_type_id
      WHERE x.order_id = ? ORDER BY x.id`, [order.id])
    const chargeTotal = autoRoomTotal + otherTotal
    const netPaid = receiptTotal - refundTotal
    return {
      orderId: order.id,
      orderNo: order.order_no,
      status: order.status,
      roomNo: currentRoom.room_no,
      roomId: currentRoom.room_id,
      nights: roomChargeRows.length,
      nightlyRateCents: currentRoom.nightly_rate_cents,
      roomChargeRows,
      autoRoomTotalCents: autoRoomTotal,
      otherCharges,
      payments,
      guests,
      segments,
      chargeTotalCents: chargeTotal,
      receiptTotalCents: receiptTotal,
      refundTotalCents: refundTotal,
      depositTotalCents: depositTotal,
      netPaidCents: netPaid,
      balanceCents: chargeTotal - netPaid
    }
  }

  addCharge(input) {
    const orderId = positiveId(input.orderId, '订单')
    const order = this.database.get('SELECT * FROM orders WHERE id = ?', [orderId])
    assert(order && order.status === 'CHECKED_IN', 'INVALID_ORDER_STATE', '只能给在住订单添加费用')
    const type = text(input.type)
    assert(CHARGE_TYPES.has(type), 'INVALID_FIELD', '费用类型不正确')
    const description = text(input.description)
    assert(description, 'REQUIRED_FIELD', '费用说明不能为空')
    const absoluteAmount = cents(Math.abs(integer(input.amountCents, '费用金额')), '费用金额')
    const amount = type === 'DISCOUNT' ? -absoluteAmount : absoluteAmount
    if (type === 'DISCOUNT') {
      const currentBill = this.getBill(orderId)
      assert(absoluteAmount <= currentBill.chargeTotalCents, 'INVALID_AMOUNT', '优惠金额不能超过当前费用合计')
    }
    return this.database.transaction(() => {
      const result = this.database.run(`INSERT INTO charges
        (order_id, type, description, quantity, unit_price_cents, amount_cents, business_date, source, created_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, 'MANUAL', ?)`,
      [orderId, type, description, amount, amount, dateKey(new Date()), nowIso()])
      this.log('ADD_CHARGE', 'ORDER', orderId, `${description}：${amount}分`)
      return { id: result.id }
    })
  }

  voidCharge(input) {
    const orderId = positiveId(input.orderId, '订单')
    const chargeId = positiveId(input.chargeId, '费用')
    const reason = text(input.reason)
    assert(reason, 'REQUIRED_FIELD', '请填写费用作废原因')
    const order = this.getOrder(orderId)
    assert(order.status === 'CHECKED_IN', 'INVALID_ORDER_STATE', '只能作废在住订单的手工费用')
    const charge = this.database.get('SELECT * FROM charges WHERE id = ? AND order_id = ?', [chargeId, orderId])
    assert(charge && charge.source === 'MANUAL' && !charge.voided, 'INVALID_CHARGE', '该费用不能作废')
    const remaining = this.database.get('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM charges WHERE order_id = ? AND voided = 0 AND id <> ?',
      [orderId, chargeId]).total
    assert(remaining >= 0, 'INVALID_AMOUNT', '作废后费用合计将小于0，请先处理相关优惠')
    return this.database.transaction(() => {
      this.database.run('UPDATE charges SET voided = 1, void_reason = ? WHERE id = ?', [reason, chargeId])
      this.log('VOID_CHARGE', 'ORDER', orderId, `作废费用 ${charge.description}：${reason}`)
      return { id: chargeId }
    })
  }

  collectPayment(input) {
    const orderId = positiveId(input.orderId, '订单')
    const order = this.database.get('SELECT * FROM orders WHERE id = ?', [orderId])
    assert(order && ['RESERVED', 'CHECKED_IN'].includes(order.status), 'INVALID_ORDER_STATE', '只能给预订或在住订单收款')
    const amount = cents(input.amountCents, '收款金额')
    const method = text(input.method)
    assert(PAYMENT_METHODS.has(method), 'INVALID_FIELD', '支付方式不正确')
    const purpose = text(input.purpose) || 'ROOM'
    assert(['ROOM', 'DEPOSIT', 'OTHER'].includes(purpose), 'INVALID_FIELD', '收款用途不正确')
    return this.database.transaction(() => {
      const result = this.database.run(`INSERT INTO payments
        (order_id, direction, purpose, method, amount_cents, notes, created_at)
        VALUES (?, 'RECEIPT', ?, ?, ?, ?, ?)`,
      [orderId, purpose, method, amount, text(input.notes), nowIso()])
      this.log('COLLECT', 'ORDER', orderId, `收款 ${amount} 分`)
      return { id: result.id }
    })
  }

  refundPayment(input) {
    const orderId = positiveId(input.orderId, '订单')
    const paymentId = positiveId(input.paymentId, '原收款')
    const amount = cents(input.amountCents, '退款金额')
    const reason = text(input.reason)
    assert(reason, 'REQUIRED_FIELD', '请填写退款原因')
    const order = this.getOrder(orderId)
    assert(['RESERVED', 'CHECKED_IN'].includes(order.status), 'INVALID_ORDER_STATE', '只能给预订或在住订单办理退款')
    const original = this.database.get(`SELECT * FROM payments WHERE id = ? AND order_id = ?
      AND direction = 'RECEIPT' AND voided = 0`, [paymentId, orderId])
    assert(original, 'INVALID_PAYMENT', '未找到可退款的原收款')
    const refunded = this.database.get(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments
      WHERE original_payment_id = ? AND direction = 'REFUND' AND voided = 0`, [paymentId]).total
    assert(amount <= original.amount_cents - refunded, 'REFUND_EXCEEDS_PAYMENT', '退款金额超过原收款的可退余额')
    const method = text(input.method) || original.method
    assert(PAYMENT_METHODS.has(method), 'INVALID_FIELD', '退款方式不正确')
    return this.database.transaction(() => {
      const result = this.database.run(`INSERT INTO payments
        (order_id, direction, purpose, method, amount_cents, notes, original_payment_id, created_at)
        VALUES (?, 'REFUND', ?, ?, ?, ?, ?, ?)`,
      [orderId, original.purpose, method, amount, reason, paymentId, nowIso()])
      this.log('REFUND', 'ORDER', orderId, `退款 ${amount} 分：${reason}`)
      return { id: result.id }
    })
  }

  checkOut(input) {
    const orderId = positiveId(input.orderId, '订单')
    const checkoutAt = isoDate(input.checkoutAt, '退房时间')
    const order = this.getOrder(orderId)
    assert(order.status === 'CHECKED_IN', 'INVALID_ORDER_STATE', '该订单不是在住状态，不能退房')
    const stay = this.database.get(`SELECT o.*, x.id AS order_room_id, x.room_id, x.actual_checkin AS room_checkin,
      x.nightly_rate_cents, r.room_no FROM orders o JOIN order_rooms x ON x.order_id = o.id
      JOIN rooms r ON r.id = x.room_id WHERE o.id = ? AND x.status = 'CHECKED_IN'`, [orderId])
    assert(stay, 'NOT_FOUND', '未找到在住房间')
    assert(new Date(checkoutAt) >= new Date(stay.room_checkin), 'INVALID_DATE_RANGE', '退房时间不能早于入住时间')
    const bill = this.getBill(orderId, checkoutAt)
    const settlementAmount = Math.abs(bill.balanceCents)
    const providedAmount = integer(input.settlementAmountCents || 0, '结算金额')
    assert(providedAmount === settlementAmount, 'SETTLEMENT_MISMATCH', '结算金额与账单余额不一致，请刷新账单')
    const method = text(input.method) || 'CASH'
    if (settlementAmount > 0) assert(PAYMENT_METHODS.has(method), 'INVALID_FIELD', '支付方式不正确')

    return this.database.transaction(() => {
      const now = nowIso()
      if (settlementAmount > 0) {
        this.database.run(`INSERT INTO payments
          (order_id, direction, purpose, method, amount_cents, notes, created_at)
          VALUES (?, ?, 'ROOM', ?, ?, ?, ?)`,
        [orderId, bill.balanceCents > 0 ? 'RECEIPT' : 'REFUND', method, settlementAmount,
          bill.balanceCents > 0 ? '退房补收' : '退房退款', now])
      }
      this.database.run(`UPDATE orders SET status = 'CHECKED_OUT', actual_checkout = ?, updated_at = ? WHERE id = ?`,
        [checkoutAt, now, orderId])
      this.database.run(`UPDATE order_rooms SET status = 'CHECKED_OUT', actual_checkout = ?, updated_at = ? WHERE id = ?`,
        [checkoutAt, now, stay.order_room_id])
      this.database.run("UPDATE rooms SET cleaning_status = 'DIRTY', updated_at = ? WHERE id = ?", [now, stay.room_id])
      this.rebuildAutoRoomCharges(orderId)
      this.log('CHECK_OUT', 'ORDER', orderId, `订单 ${stay.order_no} 退房，房间 ${stay.room_no} 待清洁`)
      return { orderId, orderNo: stay.order_no, settlementAmountCents: settlementAmount }
    })
  }

  extendStay(input) {
    const order = this.getOrder(input.orderId)
    assert(order.status === 'CHECKED_IN', 'INVALID_ORDER_STATE', '只有在住订单可以续住')
    const room = this.getCurrentOrderRoom(order.id)
    const newCheckout = isoDate(input.expectedCheckout, '新预计离店时间')
    assert(new Date(newCheckout) > new Date(order.expected_checkout), 'INVALID_DATE_RANGE', '新离店时间必须晚于原离店时间')
    this.assertRoomAvailable(room.room_id, order.expected_checkout, newCheckout, { excludeOrderId: order.id })
    return this.database.transaction(() => {
      const now = nowIso()
      this.database.run('UPDATE orders SET expected_checkout = ?, updated_at = ? WHERE id = ?', [newCheckout, now, order.id])
      this.database.run('UPDATE order_rooms SET expected_checkout = ?, updated_at = ? WHERE id = ?', [newCheckout, now, room.id])
      this.rebuildAutoRoomCharges(order.id)
      this.log('EXTEND_STAY', 'ORDER', order.id, `订单 ${order.order_no} 续住至 ${newCheckout}`)
      return { orderId: order.id, expectedCheckout: newCheckout }
    })
  }

  changeRoom(input) {
    const order = this.getOrder(input.orderId)
    assert(order.status === 'CHECKED_IN', 'INVALID_ORDER_STATE', '只有在住订单可以换房')
    const oldRoom = this.getCurrentOrderRoom(order.id)
    const newRoomId = positiveId(input.roomId, '新房间')
    assert(newRoomId !== oldRoom.room_id, 'INVALID_FIELD', '新房间不能与当前房间相同')
    const changeAt = isoDate(input.changeAt, '换房时间')
    assert(new Date(changeAt) >= new Date(oldRoom.actual_checkin), 'INVALID_DATE_RANGE', '换房时间不能早于当前房段入住时间')
    assert(new Date(changeAt) < new Date(order.expected_checkout), 'INVALID_DATE_RANGE', '换房时间必须早于预计离店时间')
    const newRoom = this.assertRoomAvailable(newRoomId, changeAt, order.expected_checkout, { excludeOrderId: order.id })
    const rate = cents(input.nightlyRateCents ?? newRoom.standard_price_cents, '新房成交价', { allowZero: true })
    const rateMode = input.sameDayRateMode === 'OLD' ? 'OLD' : 'NEW'
    const reason = text(input.reason)
    assert(reason, 'REQUIRED_FIELD', '请填写换房原因')
    return this.database.transaction(() => {
      const now = nowIso()
      this.database.run(`UPDATE order_rooms SET status = 'CHECKED_OUT', actual_checkout = ?, expected_checkout = ?, updated_at = ? WHERE id = ?`,
        [changeAt, changeAt, now, oldRoom.id])
      this.database.run('UPDATE orders SET same_day_rate_mode = ?, updated_at = ? WHERE id = ?', [rateMode, now, order.id])
      const next = this.database.run(`INSERT INTO order_rooms
        (order_id, room_id, room_type_id, nightly_rate_cents, expected_checkin, expected_checkout,
          actual_checkin, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'CHECKED_IN', ?, ?)`,
      [order.id, newRoomId, newRoom.room_type_id, rate, changeAt, order.expected_checkout, changeAt, now, now])
      const guests = this.database.all('SELECT guest_id, is_primary FROM stay_guests WHERE order_room_id = ?', [oldRoom.id])
      for (const guest of guests) {
        this.database.run('INSERT INTO stay_guests(order_room_id, guest_id, is_primary, registered_at) VALUES (?, ?, ?, ?)',
          [next.id, guest.guest_id, guest.is_primary, now])
      }
      this.database.run("UPDATE rooms SET cleaning_status = 'DIRTY', updated_at = ? WHERE id = ?", [now, oldRoom.room_id])
      this.rebuildAutoRoomCharges(order.id, null, rateMode)
      this.log('CHANGE_ROOM', 'ORDER', order.id, `订单 ${order.order_no} 从 ${oldRoom.room_no} 换至 ${newRoom.room_no}：${reason}`)
      return { orderId: order.id, roomId: newRoomId }
    })
  }

  addStayGuest(input) {
    const order = this.getOrder(input.orderId)
    assert(order.status === 'CHECKED_IN', 'INVALID_ORDER_STATE', '只能给在住订单添加同住人')
    const room = this.getCurrentOrderRoom(order.id)
    const guestId = positiveId(input.guestId, '客户')
    const guest = this.database.get('SELECT * FROM guests WHERE id = ?', [guestId])
    assert(guest, 'NOT_FOUND', '客户不存在')
    assert(!guest.blacklisted, 'GUEST_BLACKLISTED', `该客户已列入黑名单：${guest.blacklist_reason || '未填写原因'}`)
    const existing = this.database.get('SELECT id FROM stay_guests WHERE order_room_id = ? AND guest_id = ?', [room.id, guestId])
    assert(!existing, 'DUPLICATE_GUEST', '该客户已经在当前入住人名单中')
    const count = this.database.get('SELECT COUNT(*) AS count FROM stay_guests WHERE order_room_id = ?', [room.id]).count
    assert(count < room.max_capacity, 'CAPACITY_EXCEEDED', `该房型最多登记 ${room.max_capacity} 位入住人`)
    return this.database.transaction(() => {
      const result = this.database.run('INSERT INTO stay_guests(order_room_id, guest_id, is_primary, registered_at) VALUES (?, ?, 0, ?)',
        [room.id, guestId, nowIso()])
      this.log('ADD_STAY_GUEST', 'ORDER', order.id, `添加同住人：${guest.name}`)
      return { id: result.id }
    })
  }

  removeStayGuest(input) {
    const order = this.getOrder(input.orderId)
    assert(order.status === 'CHECKED_IN', 'INVALID_ORDER_STATE', '只能修改在住订单的入住人')
    const room = this.getCurrentOrderRoom(order.id)
    const guestId = positiveId(input.guestId, '客户')
    const relation = this.database.get('SELECT * FROM stay_guests WHERE order_room_id = ? AND guest_id = ?', [room.id, guestId])
    assert(relation, 'NOT_FOUND', '入住人不存在')
    assert(!relation.is_primary, 'PRIMARY_GUEST_REQUIRED', '主住人不能移除')
    return this.database.transaction(() => {
      this.database.run('DELETE FROM stay_guests WHERE id = ?', [relation.id])
      this.log('REMOVE_STAY_GUEST', 'ORDER', order.id, `移除同住人记录：${guestId}`)
      return { id: relation.id }
    })
  }

  getSettings() {
    const result = {
      hotelName: '我的酒店',
      address: '',
      phone: '',
      defaultDepositCents: 0,
      defaultCheckinHour: 14,
      defaultCheckoutHour: 12
    }
    for (const row of this.database.all('SELECT key, value FROM settings')) {
      if (!(row.key in result)) continue
      try { result[row.key] = JSON.parse(row.value) } catch (_) {}
    }
    return result
  }

  saveSettings(input) {
    const hotelName = text(input.hotelName)
    assert(hotelName, 'REQUIRED_FIELD', '酒店名称不能为空')
    const values = {
      hotelName,
      address: text(input.address),
      phone: text(input.phone),
      defaultDepositCents: cents(input.defaultDepositCents || 0, '默认押金', { allowZero: true }),
      defaultCheckinHour: integer(input.defaultCheckinHour, '默认入住小时'),
      defaultCheckoutHour: integer(input.defaultCheckoutHour, '默认退房小时')
    }
    assert(values.defaultCheckinHour >= 0 && values.defaultCheckinHour <= 23, 'INVALID_FIELD', '默认入住时间不正确')
    assert(values.defaultCheckoutHour >= 0 && values.defaultCheckoutHour <= 23, 'INVALID_FIELD', '默认退房时间不正确')
    return this.database.transaction(() => {
      const now = nowIso()
      for (const [key, value] of Object.entries(values)) {
        this.database.run(`INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, JSON.stringify(value), now])
      }
      this.log('UPDATE_SETTINGS', 'SETTINGS', null, '修改酒店基本资料和业务默认值')
      return values
    })
  }

  getDailyReport(input = {}) {
    const today = dateKey(new Date())
    const startDate = text(input.startDate) || today
    const endDate = text(input.endDate) || today
    assert(/^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate), 'INVALID_DATE', '报表日期格式不正确')
    const start = new Date(`${startDate}T00:00:00`)
    const end = new Date(`${endDate}T00:00:00`)
    assert(end >= start, 'INVALID_DATE_RANGE', '结束日期不能早于开始日期')
    const dayCount = Math.floor((end - start) / 86400000) + 1
    assert(dayCount <= 366, 'DATE_RANGE_TOO_LARGE', '单次报表最多查询366天')
    const totalRooms = this.database.get("SELECT COUNT(*) AS count FROM rooms WHERE enabled = 1").count
    const rows = []
    for (let index = 0; index < dayCount; index += 1) {
      const day = new Date(start)
      day.setDate(start.getDate() + index)
      const key = dateKey(day)
      const charges = this.database.get(`SELECT
        COALESCE(SUM(CASE WHEN type = 'ROOM' THEN amount_cents ELSE 0 END), 0) AS room_revenue,
        COALESCE(SUM(CASE WHEN type <> 'ROOM' THEN amount_cents ELSE 0 END), 0) AS other_revenue,
        COUNT(DISTINCT CASE WHEN type = 'ROOM' THEN order_room_id END) AS occupied_rooms
        FROM charges WHERE voided = 0 AND business_date = ?`, [key])
      const payments = this.database.get(`SELECT
        COALESCE(SUM(CASE WHEN direction = 'RECEIPT' THEN amount_cents ELSE 0 END), 0) AS receipts,
        COALESCE(SUM(CASE WHEN direction = 'REFUND' THEN amount_cents ELSE 0 END), 0) AS refunds
        FROM payments WHERE voided = 0 AND date(created_at, 'localtime') = ?`, [key])
      const activity = this.database.get(`SELECT
        COALESCE(SUM(CASE WHEN actual_checkin IS NOT NULL AND date(actual_checkin, 'localtime') = ? THEN 1 ELSE 0 END), 0) AS checkins,
        COALESCE(SUM(CASE WHEN actual_checkout IS NOT NULL AND date(actual_checkout, 'localtime') = ? THEN 1 ELSE 0 END), 0) AS checkouts
        FROM orders`, [key, key])
      rows.push({
        date: key,
        totalRooms,
        occupiedRooms: charges.occupied_rooms,
        occupancyRate: totalRooms ? Number(((charges.occupied_rooms / totalRooms) * 100).toFixed(2)) : 0,
        checkins: activity.checkins,
        checkouts: activity.checkouts,
        roomRevenueCents: charges.room_revenue,
        otherRevenueCents: charges.other_revenue,
        totalRevenueCents: charges.room_revenue + charges.other_revenue,
        receiptsCents: payments.receipts,
        refundsCents: payments.refunds,
        netReceiptsCents: payments.receipts - payments.refunds
      })
    }
    return rows
  }

  listOperationLogs(input = {}) {
    const page = Math.max(1, integer(input.page || 1, '页码'))
    const pageSize = Math.min(100, Math.max(10, integer(input.pageSize || 20, '每页数量')))
    const keyword = text(input.keyword)
    const action = text(input.action)
    const startDate = text(input.startDate)
    const endDate = text(input.endDate)
    const conditions = []
    const params = []
    if (keyword) {
      const pattern = `%${keyword}%`
      conditions.push('(summary LIKE ? OR operator_name LIKE ? OR entity_type LIKE ?)')
      params.push(pattern, pattern, pattern)
    }
    if (action) { conditions.push('action = ?'); params.push(action) }
    if (startDate) { conditions.push("date(created_at, 'localtime') >= ?"); params.push(startDate) }
    if (endDate) { conditions.push("date(created_at, 'localtime') <= ?"); params.push(endDate) }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = this.database.get(`SELECT COUNT(*) AS count FROM operation_logs ${where}`, params).count
    const offset = (page - 1) * pageSize
    const items = this.database.all(`SELECT *, date(created_at, 'localtime') AS log_date
      FROM operation_logs ${where} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${offset}`, params)
    const actions = this.database.all('SELECT DISTINCT action FROM operation_logs ORDER BY action').map((row) => row.action)
    return { items, total, page, pageSize, actions }
  }
}

module.exports = { HotelService, enumerateNights, orderNumber, isValidChineseIdCard, AppError }
