const { ipcMain, dialog, app } = require('electron')
const path = require('path')
const fs = require('fs')
const { toPublicError, AppError } = require('./errors')
const { stringifyCsv, parseCsv } = require('./csv')

const GUEST_CSV_HEADERS = ['姓名', '证件类型', '证件号码', '手机号', '地址', '备注', '黑名单', '黑名单原因']
const DOCUMENT_TYPE_LABELS = { ID_CARD: '居民身份证', PASSPORT: '护照', OTHER: '其他证件' }

function guestRowsFromCsv(content) {
  const rows = parseCsv(content)
  if (!rows.length) throw new AppError('INVALID_CSV', 'CSV 文件为空')
  const headers = rows[0].map((item) => item.trim())
  const indexes = Object.fromEntries(headers.map((header, index) => [header, index]))
  for (const required of ['姓名', '证件类型', '证件号码']) {
    if (indexes[required] === undefined) throw new AppError('INVALID_CSV', `CSV 缺少“${required}”列，请使用系统导出的表格格式`)
  }
  const cell = (row, name) => indexes[name] === undefined ? '' : String(row[indexes[name]] ?? '').trim()
  return rows.slice(1).map((row) => {
    const documentLabel = cell(row, '证件类型')
    const documentType = { 居民身份证: 'ID_CARD', 身份证: 'ID_CARD', ID_CARD: 'ID_CARD', 护照: 'PASSPORT', PASSPORT: 'PASSPORT', 其他证件: 'OTHER', OTHER: 'OTHER' }[documentLabel]
    const blacklistValue = cell(row, '黑名单').toLowerCase()
    return {
      name: cell(row, '姓名'), documentType: documentType || documentLabel, documentNo: cell(row, '证件号码'),
      phone: cell(row, '手机号'), address: cell(row, '地址'), notes: cell(row, '备注'),
      blacklisted: ['是', '1', 'true', '黑名单'].includes(blacklistValue), blacklistReason: cell(row, '黑名单原因')
    }
  })
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function registerIpcHandlers({ service, database, userDataPath, getWindow }) {
  const handle = (channel, callback, options = {}) => {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        if (!options.publicAccess) service.requireAuthenticated()
        return { ok: true, data: await callback(payload || {}) }
      } catch (error) {
        return { ok: false, error: toPublicError(error) }
      }
    })
  }

  handle('auth:status', () => service.getAuthStatus(), { publicAccess: true })
  handle('app:version', () => app.getVersion(), { publicAccess: true })
  handle('auth:register', (payload) => service.registerAdmin(payload), { publicAccess: true })
  handle('auth:login', (payload) => service.login(payload), { publicAccess: true })
  handle('auth:logout', () => service.logout())
  handle('auth:update-profile', (payload) => service.updateProfile(payload))
  handle('auth:change-password', (payload) => service.changePassword(payload))

  handle('dashboard:get', () => service.getDashboard())

  handle('room-types:list', (payload) => service.listRoomTypes(payload.includeDisabled !== false))
  handle('room-types:save', (payload) => service.saveRoomType(payload))
  handle('room-types:toggle', (payload) => service.toggleRoomType(payload.id, payload.enabled))

  handle('rooms:list', () => service.listRooms())
  handle('rooms:save', (payload) => service.saveRoom(payload))
  handle('rooms:toggle', (payload) => service.toggleRoom(payload.id, payload.enabled))
  handle('rooms:mark-clean', (payload) => service.markRoomClean(payload.id))
  handle('rooms:maintenance', (payload) => service.setRoomMaintenance(payload.id, payload.enabled, payload.reason))

  handle('guests:list', (payload) => service.listGuests(payload.keyword))
  handle('guests:save', (payload) => service.saveGuest(payload))
  handle('guests:export', async () => {
    const guests = service.listGuestsForExport()
    const result = await dialog.showSaveDialog(getWindow(), {
      title: '导出客户档案',
      defaultPath: path.join(app.getPath('documents'), `hotel-guests-${new Date().toISOString().slice(0, 10)}.csv`),
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    const rows = guests.map((guest) => [guest.name, DOCUMENT_TYPE_LABELS[guest.document_type] || guest.document_type,
      guest.document_no, guest.phone, guest.address, guest.notes, guest.blacklisted ? '是' : '否', guest.blacklist_reason])
    fs.writeFileSync(result.filePath, `\uFEFF${stringifyCsv(GUEST_CSV_HEADERS, rows)}`, 'utf8')
    service.recordGuestExport(guests.length)
    return { canceled: false, filePath: result.filePath, count: guests.length }
  })
  handle('guests:import', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '导入客户档案',
      properties: ['openFile'],
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const filePath = result.filePaths[0]
    if (fs.statSync(filePath).size > 5 * 1024 * 1024) throw new AppError('INVALID_CSV', '客户 CSV 文件不能超过 5MB')
    const rows = guestRowsFromCsv(fs.readFileSync(filePath, 'utf8'))
    return { canceled: false, filePath, ...service.importGuests(rows) }
  })

  handle('stays:list', (payload) => service.listStays(payload.status, payload.keyword))
  handle('stays:check-in', (payload) => service.checkIn(payload))
  handle('stays:create-reservation', (payload) => service.createReservation(payload))
  handle('stays:check-in-reservation', (payload) => service.checkInReservation(payload))
  handle('stays:cancel-reservation', (payload) => service.cancelReservation(payload))
  handle('stays:bill', (payload) => service.getBill(payload.orderId, payload.checkoutAt))
  handle('stays:add-charge', (payload) => service.addCharge(payload))
  handle('stays:void-charge', (payload) => service.voidCharge(payload))
  handle('stays:collect', (payload) => service.collectPayment(payload))
  handle('stays:refund', (payload) => service.refundPayment(payload))
  handle('stays:check-out', (payload) => service.checkOut(payload))
  handle('stays:extend', (payload) => service.extendStay(payload))
  handle('stays:change-room', (payload) => service.changeRoom(payload))
  handle('stays:add-guest', (payload) => service.addStayGuest(payload))
  handle('stays:remove-guest', (payload) => service.removeStayGuest(payload))

  handle('logs:list', (payload) => service.listOperationLogs(payload))
  handle('settings:get', () => {
    const settings = service.getSettings()
    const window = getWindow()
    if (window) window.setTitle(settings.hotelName || '酒店管家')
    return settings
  })
  handle('settings:save', (payload) => {
    const settings = service.saveSettings(payload)
    const window = getWindow()
    if (window) window.setTitle(settings.hotelName || '酒店管家')
    return settings
  })
  handle('reports:daily', (payload) => service.getDailyReport(payload))
  handle('reports:export-daily', async (payload) => {
    const rows = service.getDailyReport(payload)
    const result = await dialog.showSaveDialog(getWindow(), {
      title: '导出每日经营报表',
      defaultPath: path.join(app.getPath('documents'), `hotel-daily-report-${payload.startDate}-${payload.endDate}.csv`),
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    const header = ['日期', '可售房数', '已售间夜', '入住率(%)', '入住数', '退房数', '房费收入(元)', '其他费用(元)', '费用合计(元)', '收款(元)', '退款(元)', '净收款(元)']
    const lines = rows.map((row) => [row.date, row.totalRooms, row.occupiedRooms, row.occupancyRate, row.checkins, row.checkouts,
      (row.roomRevenueCents / 100).toFixed(2), (row.otherRevenueCents / 100).toFixed(2), (row.totalRevenueCents / 100).toFixed(2),
      (row.receiptsCents / 100).toFixed(2), (row.refundsCents / 100).toFixed(2), (row.netReceiptsCents / 100).toFixed(2)].join(','))
    fs.writeFileSync(result.filePath, `\uFEFF${[header.join(','), ...lines].join('\r\n')}`, 'utf8')
    return { canceled: false, filePath: result.filePath }
  })

  handle('backup:create', async () => {
    const result = await dialog.showSaveDialog(getWindow(), {
      title: '保存酒店数据备份',
      defaultPath: path.join(app.getPath('documents'), `hotel-backup-${timestamp()}.sqlite`),
      filters: [{ name: '酒店数据库备份', extensions: ['sqlite'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    database.backupTo(result.filePath)
    return { canceled: false, filePath: result.filePath }
  })

  handle('backup:restore', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择酒店数据备份',
      properties: ['openFile'],
      filters: [{ name: '酒店数据库备份', extensions: ['sqlite'] }]
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const safetyDirectory = path.join(userDataPath, 'backups')
    fs.mkdirSync(safetyDirectory, { recursive: true })
    const safetyBackupPath = path.join(safetyDirectory, `before-restore-${timestamp()}.sqlite`)
    database.restoreFrom(result.filePaths[0], safetyBackupPath)
    service.logout(false)
    return { canceled: false, safetyBackupPath, requiresLogin: true }
  })
}

module.exports = { registerIpcHandlers }
