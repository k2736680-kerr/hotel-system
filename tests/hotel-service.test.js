const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { HotelDatabase } = require('../src/main/database')
const { HotelService, AppError, enumerateNights } = require('../src/main/hotel-service')
const { stringifyCsv, parseCsv } = require('../src/main/csv')

async function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hotel-system-'))
  const filePath = path.join(directory, 'hotel.sqlite')
  const database = await HotelDatabase.open(filePath)
  const service = new HotelService(database)
  t.after(() => {
    database.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { directory, filePath, database, service }
}

function addRoomAndGuest(service) {
  const roomType = service.listRoomTypes(false)[0]
  const room = service.saveRoom({ roomNo: '1001', roomTypeId: roomType.id, floor: '1F', notes: '' })
  const guest = service.saveGuest({
    name: '测试客户', documentType: 'ID_CARD', documentNo: '11010519491231002X',
    phone: '13800138000', address: '', notes: ''
  })
  return { roomType, room, guest }
}

test('按日历日期计算住宿夜数，至少计一夜', () => {
  assert.deepEqual(enumerateNights('2026-01-01T08:00:00.000Z', '2026-01-01T10:00:00.000Z').length, 1)
  assert.deepEqual(enumerateNights('2026-01-01T08:00:00.000Z', '2026-01-03T08:00:00.000Z').length, 2)
})

test('房间和客户持久化并阻止重复数据', async (t) => {
  const { filePath, database, service } = await createFixture(t)
  const { room, guest } = addRoomAndGuest(service)
  assert.ok(room.id > 0)
  assert.ok(guest.id > 0)
  assert.throws(() => service.saveRoom({ roomNo: '1001', roomTypeId: 1 }), (error) => error instanceof AppError && error.code === 'DUPLICATE_ROOM')
  assert.throws(() => service.saveGuest({ name: '重复', documentType: 'ID_CARD', documentNo: '11010519491231002X' }),
    (error) => error instanceof AppError && error.code === 'DUPLICATE_GUEST')

  database.persist()
  const reopened = await HotelDatabase.open(filePath)
  assert.equal(new HotelService(reopened).listRooms()[0].room_no, '1001')
  assert.equal(new HotelService(reopened).listGuests()[0].name, '测试客户')
  reopened.close()
})

test('入住、收款、退房和清洁形成一致业务闭环', async (t) => {
  const { service } = await createFixture(t)
  const { room, guest } = addRoomAndGuest(service)
  const stay = service.checkIn({
    roomId: room.id,
    guestId: guest.id,
    actualCheckin: '2026-01-01T06:00:00.000Z',
    expectedCheckout: '2026-01-03T04:00:00.000Z',
    nightlyRateCents: 18800,
    depositCents: 10000,
    paymentMethod: 'CASH'
  })

  assert.equal(service.listRooms()[0].display_status, 'OCCUPIED')
  const initialBill = service.getBill(stay.orderId)
  assert.equal(initialBill.nights, 2)
  assert.equal(initialBill.chargeTotalCents, 37600)
  assert.equal(initialBill.balanceCents, 27600)

  assert.throws(() => service.checkIn({
    roomId: room.id, guestId: guest.id,
    actualCheckin: '2026-01-01T07:00:00.000Z', expectedCheckout: '2026-01-02T04:00:00.000Z',
    nightlyRateCents: 18800
  }), (error) => error instanceof AppError && error.code === 'ROOM_CONFLICT')

  service.collectPayment({ orderId: stay.orderId, amountCents: 27600, purpose: 'ROOM', method: 'WECHAT' })
  const checkoutBill = service.getBill(stay.orderId, '2026-01-02T04:00:00.000Z')
  assert.equal(checkoutBill.nights, 1)
  assert.equal(checkoutBill.balanceCents, -18800)

  service.checkOut({
    orderId: stay.orderId,
    checkoutAt: '2026-01-02T04:00:00.000Z',
    settlementAmountCents: 18800,
    method: 'CASH'
  })
  assert.equal(service.listStays('CHECKED_OUT').length, 1)
  assert.equal(service.listRooms()[0].display_status, 'DIRTY')
  assert.throws(() => service.checkOut({ orderId: stay.orderId, checkoutAt: '2026-01-02T05:00:00.000Z', settlementAmountCents: 0 }),
    (error) => error instanceof AppError && error.code === 'INVALID_ORDER_STATE')

  service.markRoomClean(room.id)
  assert.equal(service.listRooms()[0].display_status, 'VACANT')
})

test('备份校验与恢复会还原备份时数据', async (t) => {
  const { directory, database, service } = await createFixture(t)
  addRoomAndGuest(service)
  const backupPath = path.join(directory, 'manual.sqlite')
  database.backupTo(backupPath)
  service.saveRoom({ roomNo: '1002', roomTypeId: service.listRoomTypes(false)[0].id })
  assert.equal(service.listRooms().length, 2)

  const safetyPath = path.join(directory, 'safety.sqlite')
  database.restoreFrom(backupPath, safetyPath)
  assert.equal(service.listRooms().length, 1)
  assert.ok(fs.existsSync(safetyPath))
})

test('预订会锁定时段，取消时自动退回已收定金', async (t) => {
  const { service } = await createFixture(t)
  const { room, guest } = addRoomAndGuest(service)
  const anotherGuest = service.saveGuest({ name: '另一客户', documentType: 'ID_CARD', documentNo: '110105194912310011' })
  const reservation = service.createReservation({
    roomId: room.id, guestId: guest.id,
    expectedCheckin: '2026-07-01T06:00:00.000Z', expectedCheckout: '2026-07-03T04:00:00.000Z',
    nightlyRateCents: 18800, depositCents: 5000, paymentMethod: 'WECHAT', source: 'PHONE'
  })
  const bill = service.getBill(reservation.orderId)
  assert.equal(bill.status, 'RESERVED')
  assert.equal(bill.chargeTotalCents, 0)
  assert.equal(bill.netPaidCents, 5000)

  assert.throws(() => service.createReservation({
    roomId: room.id, guestId: anotherGuest.id,
    expectedCheckin: '2026-07-02T06:00:00.000Z', expectedCheckout: '2026-07-04T04:00:00.000Z',
    nightlyRateCents: 18800
  }), (error) => error instanceof AppError && error.code === 'ROOM_CONFLICT')

  const cancelled = service.cancelReservation({ orderId: reservation.orderId, reason: '客户行程取消', method: 'WECHAT' })
  assert.equal(cancelled.refundAmountCents, 5000)
  assert.equal(service.getBill(reservation.orderId).netPaidCents, 0)
  assert.equal(service.listStays('CANCELLED').length, 1)
})

test('预订可转入住，续住会阻止与后续预订冲突', async (t) => {
  const { service } = await createFixture(t)
  const { room, guest } = addRoomAndGuest(service)
  const anotherGuest = service.saveGuest({ name: '后续客户', documentType: 'ID_CARD', documentNo: '110105194912310011' })
  const reservation = service.createReservation({
    roomId: room.id, guestId: guest.id,
    expectedCheckin: '2026-07-01T06:00:00.000Z', expectedCheckout: '2026-07-03T04:00:00.000Z',
    nightlyRateCents: 18800
  })
  service.createReservation({
    roomId: room.id, guestId: anotherGuest.id,
    expectedCheckin: '2026-07-03T04:00:00.000Z', expectedCheckout: '2026-07-05T04:00:00.000Z',
    nightlyRateCents: 20800
  })
  service.checkInReservation({ orderId: reservation.orderId, actualCheckin: '2026-07-01T05:00:00.000Z' })
  assert.equal(service.getBill(reservation.orderId).chargeTotalCents, 37600)
  assert.throws(() => service.extendStay({ orderId: reservation.orderId, expectedCheckout: '2026-07-04T04:00:00.000Z' }),
    (error) => error instanceof AppError && error.code === 'ROOM_CONFLICT')
})

test('换房按日期只生成一次房费并保持两边房态一致', async (t) => {
  const { service } = await createFixture(t)
  const { room, guest } = addRoomAndGuest(service)
  const secondType = service.listRoomTypes(false)[1]
  const secondRoom = service.saveRoom({ roomNo: '2001', roomTypeId: secondType.id, floor: '2F' })
  const stay = service.checkIn({
    roomId: room.id, guestId: guest.id,
    actualCheckin: '2026-01-01T06:00:00.000Z', expectedCheckout: '2026-01-03T04:00:00.000Z',
    nightlyRateCents: 18800
  })
  service.changeRoom({
    orderId: stay.orderId, roomId: secondRoom.id, changeAt: '2026-01-01T10:00:00.000Z',
    nightlyRateCents: 26800, sameDayRateMode: 'OLD', reason: '客户要求换大床房'
  })
  const bill = service.getBill(stay.orderId)
  assert.equal(bill.roomChargeRows.length, 2)
  assert.deepEqual(bill.roomChargeRows.map((row) => row.nightlyRateCents), [18800, 26800])
  assert.equal(bill.chargeTotalCents, 45600)
  const states = Object.fromEntries(service.listRooms().map((item) => [item.room_no, item.display_status]))
  assert.equal(states['1001'], 'DIRTY')
  assert.equal(states['2001'], 'OCCUPIED')
})

test('同住人受房型人数限制且主住人不能移除', async (t) => {
  const { service } = await createFixture(t)
  const { room, guest } = addRoomAndGuest(service)
  const second = service.saveGuest({ name: '同住人', documentType: 'ID_CARD', documentNo: '110105194912310011' })
  const third = service.saveGuest({ name: '超员客户', documentType: 'ID_CARD', documentNo: '440524188001010014' })
  const stay = service.checkIn({
    roomId: room.id, guestId: guest.id,
    actualCheckin: '2026-01-01T06:00:00.000Z', expectedCheckout: '2026-01-02T04:00:00.000Z', nightlyRateCents: 18800
  })
  service.addStayGuest({ orderId: stay.orderId, guestId: second.id })
  assert.equal(service.getBill(stay.orderId).guests.length, 2)
  assert.throws(() => service.addStayGuest({ orderId: stay.orderId, guestId: third.id }),
    (error) => error instanceof AppError && error.code === 'CAPACITY_EXCEEDED')
  assert.throws(() => service.removeStayGuest({ orderId: stay.orderId, guestId: guest.id }),
    (error) => error instanceof AppError && error.code === 'PRIMARY_GUEST_REQUIRED')
  service.removeStayGuest({ orderId: stay.orderId, guestId: second.id })
  assert.equal(service.getBill(stay.orderId).guests.length, 1)
})

test('逆向校验拒绝错误身份证、黑名单入住、过量优惠和错误结算金额', async (t) => {
  const { service } = await createFixture(t)
  const roomType = service.listRoomTypes(false)[0]
  const room = service.saveRoom({ roomNo: '1001', roomTypeId: roomType.id })
  assert.throws(() => service.saveGuest({ name: '错证件', documentType: 'ID_CARD', documentNo: '110105194912310021' }),
    (error) => error instanceof AppError && error.code === 'INVALID_DOCUMENT')
  const blocked = service.saveGuest({
    name: '黑名单', documentType: 'ID_CARD', documentNo: '11010519491231002X',
    blacklisted: true, blacklistReason: '历史欠款'
  })
  assert.throws(() => service.checkIn({
    roomId: room.id, guestId: blocked.id, actualCheckin: '2026-01-01T06:00:00.000Z',
    expectedCheckout: '2026-01-02T04:00:00.000Z', nightlyRateCents: 18800
  }), (error) => error instanceof AppError && error.code === 'GUEST_BLACKLISTED')

  const normal = service.saveGuest({ name: '正常客户', documentType: 'ID_CARD', documentNo: '110105194912310011' })
  const stay = service.checkIn({
    roomId: room.id, guestId: normal.id, actualCheckin: '2026-01-01T06:00:00.000Z',
    expectedCheckout: '2026-01-02T04:00:00.000Z', nightlyRateCents: 18800
  })
  assert.throws(() => service.addCharge({ orderId: stay.orderId, type: 'DISCOUNT', description: '错误优惠', amountCents: 20000 }),
    (error) => error instanceof AppError && error.code === 'INVALID_AMOUNT')
  assert.throws(() => service.checkOut({
    orderId: stay.orderId, checkoutAt: '2026-01-02T04:00:00.000Z', settlementAmountCents: 1, method: 'CASH'
  }), (error) => error instanceof AppError && error.code === 'SETTLEMENT_MISMATCH')
  assert.equal(service.listRooms()[0].display_status, 'OCCUPIED')
})

test('系统设置可持久化，经营报表按业务日期汇总费用', async (t) => {
  const { service } = await createFixture(t)
  const saved = service.saveSettings({
    hotelName: '测试酒店', address: '测试地址', phone: '0755-12345678',
    defaultDepositCents: 30000, defaultCheckinHour: 14, defaultCheckoutHour: 12
  })
  assert.equal(saved.hotelName, '测试酒店')
  assert.equal(service.getSettings().defaultDepositCents, 30000)

  const { room, guest } = addRoomAndGuest(service)
  const stay = service.checkIn({
    roomId: room.id, guestId: guest.id,
    actualCheckin: '2026-01-01T06:00:00.000Z', expectedCheckout: '2026-01-02T04:00:00.000Z', nightlyRateCents: 18800
  })
  service.addCharge({ orderId: stay.orderId, type: 'SERVICE', description: '早餐', amountCents: 2000 })
  const report = service.getDailyReport({ startDate: '2026-01-01', endDate: '2026-01-01' })
  assert.equal(report.length, 1)
  assert.equal(report[0].occupiedRooms, 1)
  assert.equal(report[0].roomRevenueCents, 18800)
})

test('有效预订会阻止停用和报修，错误清洁操作不会改变数据', async (t) => {
  const { service } = await createFixture(t)
  const { room, guest } = addRoomAndGuest(service)
  service.createReservation({
    roomId: room.id, guestId: guest.id,
    expectedCheckin: '2026-08-01T06:00:00.000Z', expectedCheckout: '2026-08-02T04:00:00.000Z', nightlyRateCents: 18800
  })
  assert.throws(() => service.toggleRoom(room.id, false), (error) => error instanceof AppError && error.code === 'ROOM_IN_USE')
  assert.throws(() => service.setRoomMaintenance(room.id, true, '计划维修'), (error) => error instanceof AppError && error.code === 'ROOM_OCCUPIED')
  assert.throws(() => service.markRoomClean(room.id), (error) => error instanceof AppError && error.code === 'INVALID_ROOM_STATE')
  assert.equal(service.listRooms()[0].enabled, 1)
  assert.equal(service.listRooms()[0].maintenance_status, 'NORMAL')
})

test('损坏备份被拒绝且当前数据库保持可用', async (t) => {
  const { directory, database, service } = await createFixture(t)
  addRoomAndGuest(service)
  const corruptPath = path.join(directory, 'corrupt.sqlite')
  fs.writeFileSync(corruptPath, 'not a sqlite database')
  assert.throws(() => database.restoreFrom(corruptPath, path.join(directory, 'safety.sqlite')))
  assert.equal(service.listRooms().length, 1)
})

test('混合业务执行后订单、房间和活动房段保持全局一致', async (t) => {
  const { database, service } = await createFixture(t)
  const { roomType, room, guest } = addRoomAndGuest(service)
  const secondRoom = service.saveRoom({ roomNo: '1002', roomTypeId: roomType.id })
  const stay = service.checkIn({
    roomId: room.id, guestId: guest.id,
    actualCheckin: '2026-09-01T06:00:00.000Z', expectedCheckout: '2026-09-03T04:00:00.000Z', nightlyRateCents: 18800
  })
  service.extendStay({ orderId: stay.orderId, expectedCheckout: '2026-09-04T04:00:00.000Z' })
  service.changeRoom({
    orderId: stay.orderId, roomId: secondRoom.id, changeAt: '2026-09-02T04:00:00.000Z',
    nightlyRateCents: 19800, sameDayRateMode: 'NEW', reason: '设备噪音'
  })
  const bill = service.getBill(stay.orderId, '2026-09-04T04:00:00.000Z')
  service.checkOut({
    orderId: stay.orderId, checkoutAt: '2026-09-04T04:00:00.000Z',
    settlementAmountCents: bill.balanceCents, method: 'CARD'
  })

  assert.deepEqual(database.all(`SELECT room_id, COUNT(*) AS count FROM order_rooms
    WHERE status = 'CHECKED_IN' GROUP BY room_id HAVING COUNT(*) > 1`), [])
  assert.deepEqual(database.all(`SELECT o.id FROM orders o WHERE o.status = 'CHECKED_IN'
    AND (SELECT COUNT(*) FROM order_rooms x WHERE x.order_id = o.id AND x.status = 'CHECKED_IN') <> 1`), [])
  assert.equal(service.listStays('CHECKED_OUT').length, 1)
  assert.equal(service.listRooms().filter((item) => item.display_status === 'OCCUPIED').length, 0)
  assert.equal(service.getBill(stay.orderId).balanceCents, 0)
})

test('错误费用可有痕作废，收款退款不能超过原流水', async (t) => {
  const { database, service } = await createFixture(t)
  const { room, guest } = addRoomAndGuest(service)
  const stay = service.checkIn({
    roomId: room.id, guestId: guest.id,
    actualCheckin: '2026-10-01T06:00:00.000Z', expectedCheckout: '2026-10-02T04:00:00.000Z', nightlyRateCents: 18800
  })
  const charge = service.addCharge({ orderId: stay.orderId, type: 'SERVICE', description: '误录早餐', amountCents: 2000 })
  service.voidCharge({ orderId: stay.orderId, chargeId: charge.id, reason: '前台重复录入' })
  assert.equal(database.get('SELECT voided FROM charges WHERE id = ?', [charge.id]).voided, 1)

  const payment = service.collectPayment({ orderId: stay.orderId, amountCents: 10000, purpose: 'ROOM', method: 'WECHAT' })
  service.refundPayment({ orderId: stay.orderId, paymentId: payment.id, amountCents: 3000, reason: '收款金额录错' })
  assert.equal(service.getBill(stay.orderId).netPaidCents, 7000)
  assert.throws(() => service.refundPayment({ orderId: stay.orderId, paymentId: payment.id, amountCents: 8000, reason: '超额退款' }),
    (error) => error instanceof AppError && error.code === 'REFUND_EXCEEDS_PAYMENT')
  assert.equal(service.getBill(stay.orderId).netPaidCents, 7000)
})

test('首次注册、登录和修改密码使用哈希存储', async (t) => {
  const { filePath, database, service } = await createFixture(t)
  assert.equal(service.getAuthStatus().needsSetup, true)
  assert.throws(() => service.registerAdmin({ username: 'admin', displayName: '管理员', password: '12345678' }),
    (error) => error instanceof AppError && error.code === 'WEAK_PASSWORD')
  const registered = service.registerAdmin({ username: 'admin', displayName: '管理员', password: 'Hotel1234' })
  assert.equal(registered.authenticated, true)
  const stored = database.get('SELECT * FROM users WHERE username = ?', ['admin'])
  assert.notEqual(stored.password_hash, 'Hotel1234')
  assert.ok(stored.password_salt.length >= 16)

  service.logout()
  assert.throws(() => service.login({ username: 'admin', password: 'wrong123' }),
    (error) => error instanceof AppError && error.code === 'LOGIN_FAILED')
  service.login({ username: 'admin', password: 'Hotel1234' })
  service.changePassword({ currentPassword: 'Hotel1234', newPassword: 'NewHotel5678' })
  service.logout()
  assert.throws(() => service.login({ username: 'admin', password: 'Hotel1234' }),
    (error) => error instanceof AppError && error.code === 'LOGIN_FAILED')
  assert.equal(service.login({ username: 'admin', password: 'NewHotel5678' }).authenticated, true)

  database.close()
  const reopened = await HotelDatabase.open(filePath)
  const reopenedService = new HotelService(reopened)
  assert.equal(reopenedService.getAuthStatus().authenticated, true)
  assert.equal(reopenedService.getAuthStatus().user.displayName, '管理员')
  reopenedService.updateProfile({ displayName: '值班经理' })
  assert.equal(new HotelService(reopened).getAuthStatus().user.displayName, '值班经理')
  reopenedService.logout()
  assert.equal(new HotelService(reopened).getAuthStatus().authenticated, false)
  reopened.close()
})

test('操作日志持久化记录操作人并支持日期筛选和分页', async (t) => {
  const { service } = await createFixture(t)
  service.registerAdmin({ username: 'admin', displayName: '测试管理员', password: 'Hotel1234' })
  const roomType = service.listRoomTypes(false)[0]
  for (let index = 1; index <= 25; index += 1) {
    service.saveRoom({ roomNo: `9${String(index).padStart(3, '0')}`, roomTypeId: roomType.id })
  }
  const firstPage = service.listOperationLogs({ page: 1, pageSize: 10 })
  const secondPage = service.listOperationLogs({ page: 2, pageSize: 10 })
  assert.ok(firstPage.total >= 26)
  assert.equal(firstPage.items.length, 10)
  assert.equal(secondPage.items.length, 10)
  assert.ok(firstPage.items.every((item) => item.operator_name === '测试管理员'))
  assert.ok(firstPage.actions.includes('CREATE'))
  const today = new Date().toLocaleDateString('sv-SE')
  const filtered = service.listOperationLogs({ page: 1, pageSize: 20, startDate: today, endDate: today, keyword: '新增房间' })
  assert.equal(filtered.total, 25)
})

test('旧版本数据库升级后保留房间业务数据并进入首次账号注册', async (t) => {
  const { filePath, database, service } = await createFixture(t)
  addRoomAndGuest(service)
  database.transaction(() => {
    database.run('DROP TABLE users')
    database.run('DELETE FROM schema_migrations')
    database.run('INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)', [new Date().toISOString()])
  })
  database.close()

  const upgraded = await HotelDatabase.open(filePath)
  const upgradedService = new HotelService(upgraded)
  assert.equal(upgradedService.listRooms().length, 1)
  assert.equal(upgradedService.listGuests().length, 1)
  assert.equal(upgradedService.getAuthStatus().needsSetup, true)
  assert.equal(upgraded.get('SELECT MAX(version) AS version FROM schema_migrations').version, 4)
  upgraded.close()
})

test('客户档案批量导入会校验错误行并跳过重复证件', async (t) => {
  const { service } = await createFixture(t)
  service.saveGuest({ name: '已有客户', documentType: 'PASSPORT', documentNo: 'P-EXISTING' })
  const result = service.importGuests([
    { name: '新客户', documentType: 'PASSPORT', documentNo: 'P-NEW', phone: '13800138000', address: '测试地址' },
    { name: '重复客户', documentType: 'PASSPORT', documentNo: 'P-EXISTING' },
    { name: '错误身份证', documentType: 'ID_CARD', documentNo: '123456789012345678' }
  ])
  assert.deepEqual({ imported: result.imported, skipped: result.skipped, failed: result.failed }, { imported: 1, skipped: 1, failed: 1 })
  assert.equal(result.errors[0].row, 4)
  assert.deepEqual(service.listGuestsForExport().map((guest) => guest.document_no), ['P-EXISTING', 'P-NEW'])
})

test('客户 CSV 正确保留逗号、引号和换行内容', () => {
  const csv = stringifyCsv(['姓名', '备注'], [['张三', '含,逗号'], ['李四', '含"引号"\n换行']])
  assert.deepEqual(parseCsv(`\uFEFF${csv}`), [['姓名', '备注'], ['张三', '含,逗号'], ['李四', '含"引号"\n换行']])
})
