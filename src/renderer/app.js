const { createApp } = Vue
const { ElMessage, ElMessageBox } = ElementPlus

const paymentMethods = [
  { label: '现金', value: 'CASH' },
  { label: '微信', value: 'WECHAT' },
  { label: '支付宝', value: 'ALIPAY' },
  { label: '银行卡', value: 'CARD' },
  { label: '其他', value: 'OTHER' }
]

async function unwrap(request) {
  const result = await request
  if (result?.ok) return result.data
  const error = new Error(result?.error?.message || '操作失败')
  error.code = result?.error?.code
  error.details = result?.error?.details
  throw error
}

function tomorrowAtNoon() {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  date.setHours(12, 0, 0, 0)
  return date
}

function futureDate(days, hour) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  date.setHours(hour, 0, 0, 0)
  return date
}

function localDateKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function shortDateLabel(value) {
  return String(value || '').slice(5).replace('-', '/')
}

createApp({
  data() {
    return {
      auth: { initializing: true, needsSetup: false, authenticated: false, user: null },
      appVersion: '',
      chartTooltip: null,
      loginForm: { username: '', password: '' },
      registerForm: { username: '', displayName: '', password: '', confirmPassword: '' },
      activePage: 'dashboard',
      loading: false,
      saving: false,
      dashboard: { counts: {}, todayNetCents: 0 },
      rooms: [],
      roomTypes: [],
      guests: [],
      stays: [],
      logs: { items: [], total: 0, actions: [] },
      logDateRange: null,
      logQuery: { page: 1, pageSize: 20, keyword: '', action: '' },
      settings: {},
      settingsForm: {},
      reportDates: [new Date(new Date().getFullYear(), new Date().getMonth(), 1), new Date()],
      reportTimeRange: 'current_month',
      reportMonth: new Date(),
      reportRows: [],
      guestKeyword: '',
      roomKeyword: '',
      roomStatusFilter: '',
      stayKeyword: '',
      stayStatus: 'CHECKED_IN',
      paymentMethods,

      roomTypeDialog: false,
      roomTypeForm: {},
      roomDialog: false,
      roomForm: {},
      guestDialog: false,
      guestForm: {},
      checkInDialog: false,
      checkInRoom: null,
      checkInForm: {},
      reservationDialog: false,
      reservationForm: {},

      stayDrawer: false,
      selectedStay: null,
      selectedBill: null,
      chargeDialog: false,
      chargeForm: {},
      collectDialog: false,
      collectForm: {},
      extendDialog: false,
      extendForm: {},
      changeRoomDialog: false,
      changeRoomForm: {},
      addGuestDialog: false,
      addGuestForm: {},
      profileDialog: false,
      profileForm: {},
      passwordDialog: false,
      passwordForm: {},
      checkoutDialog: false,
      checkoutAt: null,
      checkoutBill: null,
      checkoutForm: { method: 'CASH' }
    }
  },
  computed: {
    pageTitle() {
      return { dashboard: '房态总览', rooms: '房间与房型', guests: '客户档案', stays: '预订与入住', reports: '经营报表', logs: '操作日志', settings: '系统与备份' }[this.activePage]
    },
    todayText() {
      return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full' }).format(new Date())
    },
    userInitial() {
      return (this.auth.user?.displayName || this.auth.user?.username || '管').slice(0, 1)
    },
    enabledRoomTypes() {
      return this.roomTypes.filter((item) => item.enabled)
    },
    filteredRooms() {
      const keyword = this.roomKeyword.trim().toLowerCase()
      return this.rooms.filter((room) => {
        const matchesStatus = !this.roomStatusFilter || room.display_status === this.roomStatusFilter
        const haystack = `${room.room_no} ${room.room_type_name} ${room.floor || ''}`.toLowerCase()
        return matchesStatus && (!keyword || haystack.includes(keyword))
      })
    },
    metrics() {
      const counts = this.dashboard.counts || {}
      return [
        { label: '房间总数', value: counts.total || 0, hint: '全部已建房间', className: 'blue' },
        { label: '空闲干净', value: counts.vacant || 0, hint: '当前可直接入住', className: 'green' },
        { label: '今日预抵', value: counts.reserved || 0, hint: '今天预计到店', className: 'blue' },
        { label: '当前在住', value: counts.occupied || 0, hint: '正在使用的房间', className: 'orange' },
        { label: '待清洁', value: counts.dirty || 0, hint: '确认清洁后可售', className: 'red' },
        { label: '维修/停用', value: (counts.maintenance || 0) + (counts.disabled || 0), hint: '当前不可销售', className: 'gray' },
        { label: '今日净收款', value: `¥${this.money(this.dashboard.todayNetCents || 0)}`, hint: '收款减退款', className: 'purple' }
      ]
    },
    reportOverview() {
      const sum = (key) => this.reportRows.reduce((total, row) => total + Number(row[key] || 0), 0)
      const totalRooms = sum('totalRooms')
      const occupiedRooms = sum('occupiedRooms')
      return {
        days: this.reportRows.length,
        occupancyRate: totalRooms ? (occupiedRooms * 100 / totalRooms).toFixed(1) : '0.0',
        totalRevenueCents: sum('totalRevenueCents'),
        netReceiptsCents: sum('netReceiptsCents'),
        checkins: sum('checkins')
      }
    },
    reportChart() {
      const rows = this.reportRows.map((row) => ({
        ...row,
        totalRevenueCents: Number(row.totalRevenueCents || 0),
        netReceiptsCents: Number(row.netReceiptsCents || 0),
        occupancyRate: Number(row.occupancyRate || 0),
        occupiedRooms: Number(row.occupiedRooms || 0),
        totalRooms: Number(row.totalRooms || 0)
      }))
      if (!rows.length) {
        return {
          revenuePath: '',
          receiptsPath: '',
          revenueAreaPath: '',
          revenueDots: [],
          receiptDots: [],
          xLabels: [],
          yTicks: [],
          zeroY: 240,
          occupancyTicks: [0, 25, 50, 75, 100],
          occupancyBars: []
        }
      }

      const width = 980
      const height = 300
      const left = 68
      const right = 32
      const top = 20
      const bottom = 52
      const plotWidth = width - left - right
      const plotHeight = height - top - bottom
      const values = rows.flatMap((row) => [row.totalRevenueCents, row.netReceiptsCents])
      let minValue = Math.min(0, ...values)
      let maxValue = Math.max(100, ...values)
      if (minValue === maxValue) {
        minValue -= 100
        maxValue += 100
      }
      const range = maxValue - minValue || 1
      const xAt = (index) => rows.length === 1 ? left + plotWidth / 2 : left + (plotWidth * index) / (rows.length - 1)
      const yAt = (value) => top + ((maxValue - value) / range) * plotHeight
      const pointPath = (key) => rows.map((row, index) => `${index === 0 ? 'M' : 'L'} ${xAt(index).toFixed(1)} ${yAt(row[key]).toFixed(1)}`).join(' ')
      const zeroY = yAt(0)
      const revenueAreaPath = `M ${xAt(0).toFixed(1)} ${zeroY.toFixed(1)} ${rows.map((row, index) => `L ${xAt(index).toFixed(1)} ${yAt(row.totalRevenueCents).toFixed(1)}`).join(' ')} L ${xAt(rows.length - 1).toFixed(1)} ${zeroY.toFixed(1)} Z`
      const labelEvery = Math.max(1, Math.ceil(rows.length / 6))

      return {
        revenuePath: pointPath('totalRevenueCents'),
        receiptsPath: pointPath('netReceiptsCents'),
        revenueAreaPath,
        receiptsAreaPath: `M ${xAt(0).toFixed(1)} ${zeroY.toFixed(1)} ${rows.map((row, index) => `L ${xAt(index).toFixed(1)} ${yAt(row.netReceiptsCents).toFixed(1)}`).join(' ')} L ${xAt(rows.length - 1).toFixed(1)} ${zeroY.toFixed(1)} Z`,
        revenueDots: rows.map((row, index) => ({ 
          index, 
          x: xAt(index), 
          y: yAt(row.totalRevenueCents),
          value: row.totalRevenueCents,
          label: this.chartMoneyLabel(row.totalRevenueCents),
          date: row.date,
          showLabel: rows.length <= 14 || index === rows.length - 1 || index % labelEvery === 0
        })),
        receiptDots: rows.map((row, index) => ({ 
          index, 
          x: xAt(index), 
          y: yAt(row.netReceiptsCents),
          value: row.netReceiptsCents,
          label: this.chartMoneyLabel(row.netReceiptsCents),
          date: row.date,
          showLabel: rows.length <= 14 || index === rows.length - 1 || index % labelEvery === 0
        })),
        xLabels: rows
          .map((row, index) => ({ index, x: xAt(index), label: shortDateLabel(row.date), show: index === 0 || index === rows.length - 1 || index % labelEvery === 0 }))
          .filter((item) => item.show),
        yTicks: Array.from({ length: 5 }, (_, index) => {
          const value = maxValue - (range * index) / 4
          return { index, y: yAt(value), label: this.chartMoneyLabel(value) }
        }),
        zeroY,
        maxValue,
        minValue,
        occupancyTicks: [0, 25, 50, 75, 100],
        occupancyBars: rows.map((row, index) => ({
          index,
          date: row.date,
          label: shortDateLabel(row.date),
          rate: row.occupancyRate,
          occupiedRooms: row.occupiedRooms,
          totalRooms: row.totalRooms,
          fillHeight: row.occupancyRate <= 0 ? 0 : Math.max(6, Math.min(100, row.occupancyRate)),
          showLabel: index === 0 || index === rows.length - 1 || index % labelEvery === 0,
          showCount: rows.length <= 10 || index === rows.length - 1 || index % labelEvery === 0
        }))
      }
    },
    checkInRoomLabel() {
      return this.checkInRoom ? `${this.checkInRoom.room_no} · ${this.checkInRoom.room_type_name}` : ''
    },
    reservableRooms() {
      return this.rooms.filter((room) => room.enabled && room.maintenance_status === 'NORMAL')
    },
    changeableRooms() {
      return this.rooms.filter((room) => room.display_status === 'VACANT' && room.id !== this.selectedBill?.roomId)
    },
    availableStayGuests() {
      const selectedIds = new Set((this.selectedBill?.guests || []).map((guest) => guest.id))
      return this.guests.filter((guest) => !selectedIds.has(guest.id))
    },
    billChargeRows() {
      if (!this.selectedBill) return []
      return [
        ...this.selectedBill.roomChargeRows.map((row, index) => ({ id: `auto-room-${index}`, type: 'ROOM', description: row.description, amount_cents: row.nightlyRateCents })),
        ...this.selectedBill.otherCharges
      ]
    }
  },
  async mounted() {
    await this.loadAppVersion()
    await this.initializeAuth()
  },
  methods: {
    showChartTooltip(point, label) {
      const type = label === '费用收入' ? 'revenue' : 'receipts'
      this.chartTooltip = {
        x: point.x,
        y: point.y,
        date: point.date,
        label: label,
        value: point.label,
        type: type
      }
    },
    hideChartTooltip() {
      this.chartTooltip = null
    },
    async loadAppVersion() {
      try {
        const result = await window.hotelAPI.app.version()
        this.appVersion = result?.data || ''
      } catch (error) {
        console.warn('Failed to load app version:', error)
      }
    },
    async initializeAuth() {
      this.auth.initializing = true
      try {
        const status = await unwrap(window.hotelAPI.auth.status())
        this.auth = { initializing: false, ...status }
        if (status.authenticated) await this.refreshAll()
      } catch (error) {
        ElMessage.error(error.message)
        this.auth.initializing = false
      }
    },
    async submitRegister() {
      if (this.registerForm.password !== this.registerForm.confirmPassword) return ElMessage.warning('两次输入的密码不一致')
      const result = await this.run(() => unwrap(window.hotelAPI.auth.register({
        username: this.registerForm.username,
        displayName: this.registerForm.displayName,
        password: this.registerForm.password
      })), '管理员账号已创建')
      if (!result) return
      this.auth = { initializing: false, ...result }
      await this.refreshAll()
    },
    async submitLogin() {
      const result = await this.run(() => unwrap(window.hotelAPI.auth.login({
        username: this.loginForm.username,
        password: this.loginForm.password
      })))
      if (!result) return
      this.auth = { initializing: false, ...result }
      this.loginForm.password = ''
      await this.refreshAll()
    },
    async logout() {
      const username = this.auth.user?.username || this.loginForm.username || ''
      try { await ElMessageBox.confirm('确定退出当前账号？', '退出登录', { type: 'warning' }) } catch (_) { return }
      const result = await this.run(() => unwrap(window.hotelAPI.auth.logout()))
      if (!result) return
      this.auth = { initializing: false, ...result }
      this.loginForm = { username, password: '' }
      this.activePage = 'dashboard'
    },
    handleUserCommand(command) {
      if (command === 'profile') return this.openProfileDialog()
      if (command === 'password') return this.openPasswordDialog()
      if (command === 'logout') return this.logout()
      return null
    },
    openProfileDialog() {
      this.profileForm = { displayName: this.auth.user?.displayName || '' }
      this.profileDialog = true
    },
    async submitProfile() {
      const result = await this.run(() => unwrap(window.hotelAPI.auth.updateProfile({
        displayName: this.profileForm.displayName
      })), '账号名称已更新')
      if (!result) return
      this.auth = { initializing: false, ...result }
      this.profileDialog = false
    },
    openPasswordDialog() {
      this.passwordForm = { currentPassword: '', newPassword: '', confirmPassword: '' }
      this.passwordDialog = true
    },
    async submitChangePassword() {
      if (this.passwordForm.newPassword !== this.passwordForm.confirmPassword) return ElMessage.warning('两次输入的新密码不一致')
      const result = await this.run(() => unwrap(window.hotelAPI.auth.changePassword({
        currentPassword: this.passwordForm.currentPassword,
        newPassword: this.passwordForm.newPassword
      })), '登录密码已修改')
      if (result) this.passwordDialog = false
    },
    async run(action, successMessage = '') {
      this.saving = true
      try {
        const result = await action()
        if (successMessage) ElMessage.success(successMessage)
        return result
      } catch (error) {
        ElMessage.error(error.message)
        return null
      } finally {
        this.saving = false
      }
    },
    money(value) {
      return (Number(value || 0) / 100).toFixed(2)
    },
    chartMoneyLabel(value) {
      const amount = Number(value || 0) / 100
      const absolute = Math.abs(amount)
      if (absolute >= 10000) return `¥${(amount / 10000).toFixed(1)}万`
      return `¥${amount.toFixed(0)}`
    },
    toCents(value) {
      return Math.round(Number(value || 0) * 100)
    },
    dateTime(value) {
      if (!value) return '-'
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
    },
    statusText(value) {
      return { VACANT: '空闲', RESERVED: '今日预抵', OCCUPIED: '入住中', DIRTY: '待清洁', MAINTENANCE: '维修中', DISABLED: '已停用' }[value] || value
    },
    statusType(value) {
      return { VACANT: 'success', RESERVED: 'primary', OCCUPIED: 'warning', DIRTY: 'danger', MAINTENANCE: 'info', DISABLED: 'info' }[value] || 'info'
    },
    orderStatusText(value) {
      return { RESERVED: '已预订', CHECKED_IN: '入住中', CHECKED_OUT: '已退房', CANCELLED: '已取消', NO_SHOW: '未到店' }[value] || value
    },
    documentText(value) {
      return { ID_CARD: '居民身份证', PASSPORT: '护照', OTHER: '其他证件' }[value] || value
    },
    maskDocument(value) {
      const raw = String(value || '')
      if (raw.length <= 8) return raw
      return `${raw.slice(0, 4)}${'*'.repeat(Math.min(10, raw.length - 8))}${raw.slice(-4)}`
    },
    paymentText(value) {
      return this.paymentMethods.find((item) => item.value === value)?.label || value
    },
    chargeTypeText(value) {
      return { ROOM: '房费', SERVICE: '服务', DAMAGE: '赔偿', DISCOUNT: '优惠', ADJUSTMENT: '调整' }[value] || value
    },

    async refreshAll() {
      this.loading = true
      try {
        const [dashboard, roomTypes, rooms, guests, stays, settings] = await Promise.all([
          unwrap(window.hotelAPI.dashboard.get()),
          unwrap(window.hotelAPI.roomTypes.list(true)),
          unwrap(window.hotelAPI.rooms.list()),
          unwrap(window.hotelAPI.guests.list(this.guestKeyword)),
          unwrap(window.hotelAPI.stays.list(this.stayStatus, this.stayKeyword)),
          unwrap(window.hotelAPI.settings.get())
        ])
        this.dashboard = dashboard
        this.roomTypes = roomTypes
        this.rooms = rooms
        this.guests = guests
        this.stays = stays
        this.settings = settings
        this.settingsForm = {
          ...settings,
          defaultDeposit: settings.defaultDepositCents / 100
        }
        if (this.activePage === 'logs') await this.loadLogs()
        if (this.activePage === 'reports') await this.loadReport()
      } catch (error) {
        ElMessage.error(error.message)
      } finally {
        this.loading = false
      }
    },
    async refreshCurrent() {
      await this.refreshAll()
    },
    async changePage(page) {
      this.activePage = page
      if (page === 'logs') await this.loadLogs()
      if (page === 'reports') await this.loadReport()
    },
    async loadGuests() {
      try { this.guests = await unwrap(window.hotelAPI.guests.list(this.guestKeyword)) } catch (error) { ElMessage.error(error.message) }
    },
    async exportGuests() {
      try {
        await ElMessageBox.confirm('导出的 CSV 包含完整证件号码和联系方式，请妥善保管。是否继续？', '导出客户档案', { type: 'warning', confirmButtonText: '继续导出' })
      } catch (_) { return }
      const result = await this.run(() => unwrap(window.hotelAPI.guests.exportCsv()))
      if (result && !result.canceled) ElMessage.success(`已导出 ${result.count} 条客户档案`)
    },
    async importGuests() {
      try {
        await ElMessageBox.confirm('请选择由本系统导出的 UTF-8 CSV。重复证件将跳过，格式错误的行不会写入。', '导入客户档案', { type: 'info', confirmButtonText: '选择文件' })
      } catch (_) { return }
      const result = await this.run(() => unwrap(window.hotelAPI.guests.importCsv()))
      if (!result || result.canceled) return
      await this.loadGuests()
      const summary = `成功 ${result.imported} 条，跳过重复 ${result.skipped} 条，失败 ${result.failed} 条`
      if (result.failed) {
        const details = result.errors.slice(0, 8).map((item) => `第 ${item.row} 行：${item.message}`).join('\n')
        await ElMessageBox.alert(`${summary}\n\n${details}`, '导入完成（存在错误行）', { type: 'warning', confirmButtonText: '知道了' })
      } else {
        ElMessage.success(summary)
      }
    },
    async loadStays() {
      try { this.stays = await unwrap(window.hotelAPI.stays.list(this.stayStatus, this.stayKeyword)) } catch (error) { ElMessage.error(error.message) }
    },
    async loadLogs() {
      const [start, end] = this.logDateRange || []
      try {
        this.logs = await unwrap(window.hotelAPI.logs.list({
          ...this.logQuery,
          startDate: start ? localDateKey(start) : '',
          endDate: end ? localDateKey(end) : ''
        }))
      } catch (error) { ElMessage.error(error.message) }
    },
    searchLogs() {
      this.logQuery.page = 1
      this.loadLogs()
    },
    handleLogPageSize() {
      this.logQuery.page = 1
      this.loadLogs()
    },
    resetLogFilters() {
      this.logDateRange = null
      this.logQuery = { page: 1, pageSize: 20, keyword: '', action: '' }
      this.loadLogs()
    },
    timeOnly(value) {
      if (!value) return '-'
      return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value))
    },
    actionText(value) {
      return {
        REGISTER_ADMIN: '注册管理员', LOGIN: '登录', LOGOUT: '退出登录', CHANGE_PASSWORD: '修改密码',
        CREATE: '新增', UPDATE: '修改', ENABLE: '启用', DISABLE: '停用', CHECK_IN: '直接入住',
        CREATE_RESERVATION: '新建预订', CHECK_IN_RESERVATION: '预订入住', CANCEL_RESERVATION: '取消预订',
        EXTEND_STAY: '续住', CHANGE_ROOM: '换房', CHECK_OUT: '退房', ADD_STAY_GUEST: '添加同住人',
        REMOVE_STAY_GUEST: '移除同住人', ADD_CHARGE: '添加费用', VOID_CHARGE: '作废费用',
        COLLECT: '收款', REFUND: '退款', MARK_CLEAN: '确认清洁', START_MAINTENANCE: '开始维修',
        END_MAINTENANCE: '结束维修', UPDATE_SETTINGS: '修改设置'
      }[value] || value
    },

    openRoomType(row = null) {
      this.roomTypeForm = row ? {
        id: row.id, name: row.name, standardPrice: row.standard_price_cents / 100,
        defaultCapacity: row.default_capacity, maxCapacity: row.max_capacity,
        description: row.description, sortOrder: row.sort_order
      } : { name: '', standardPrice: 0, defaultCapacity: 1, maxCapacity: 2, description: '', sortOrder: 0 }
      this.roomTypeDialog = true
    },
    async saveRoomType() {
      const result = await this.run(() => unwrap(window.hotelAPI.roomTypes.save({
        ...this.roomTypeForm,
        standardPriceCents: this.toCents(this.roomTypeForm.standardPrice)
      })), '房型已保存')
      if (!result) return
      this.roomTypeDialog = false
      await this.refreshAll()
    },
    async toggleRoomType(row) {
      try {
        await ElMessageBox.confirm(`确定${row.enabled ? '停用' : '启用'}房型“${row.name}”吗？`, '确认操作', { type: 'warning' })
      } catch (_) { return }
      const result = await this.run(() => unwrap(window.hotelAPI.roomTypes.toggle(row.id, !row.enabled)), '房型状态已更新')
      if (result) await this.refreshAll()
    },

    openRoom(row = null) {
      this.roomForm = row ? { id: row.id, roomNo: row.room_no, roomTypeId: row.room_type_id, floor: row.floor, notes: row.notes } : {
        roomNo: '', roomTypeId: this.enabledRoomTypes[0]?.id || null, floor: '', notes: ''
      }
      this.roomDialog = true
    },
    async saveRoom() {
      const result = await this.run(() => unwrap(window.hotelAPI.rooms.save({ ...this.roomForm })), '房间已保存')
      if (!result) return
      this.roomDialog = false
      await this.refreshAll()
    },
    async toggleRoom(row) {
      try { await ElMessageBox.confirm(`确定${row.enabled ? '停用' : '启用'}房间 ${row.room_no} 吗？`, '确认操作', { type: 'warning' }) } catch (_) { return }
      const result = await this.run(() => unwrap(window.hotelAPI.rooms.toggle(row.id, !row.enabled)), '房间状态已更新')
      if (result) await this.refreshAll()
    },
    async markClean(row) {
      try { await ElMessageBox.confirm(`确认房间 ${row.room_no} 已完成清洁检查？`, '确认清洁', { type: 'success' }) } catch (_) { return }
      const result = await this.run(() => unwrap(window.hotelAPI.rooms.markClean(row.id)), '房间已恢复空闲')
      if (result) await this.refreshAll()
    },
    async startMaintenance(row) {
      let response
      try { response = await ElMessageBox.prompt(`填写房间 ${row.room_no} 的报修原因`, '房间报修', { inputPattern: /\S+/, inputErrorMessage: '报修原因不能为空', type: 'warning' }) } catch (_) { return }
      const result = await this.run(() => unwrap(window.hotelAPI.rooms.setMaintenance(row.id, true, response.value)), '房间已进入维修状态')
      if (result) await this.refreshAll()
    },
    async endMaintenance(row) {
      try { await ElMessageBox.confirm(`确认房间 ${row.room_no} 已维修完成？完成后仍需确认清洁。`, '结束维修', { type: 'warning' }) } catch (_) { return }
      const result = await this.run(() => unwrap(window.hotelAPI.rooms.setMaintenance(row.id, false)), '维修已结束，房间待清洁')
      if (result) await this.refreshAll()
    },

    openGuest(row = null) {
      this.guestForm = row ? {
        id: row.id, name: row.name, documentType: row.document_type, documentNo: row.document_no,
        phone: row.phone, address: row.address, notes: row.notes, blacklisted: Boolean(row.blacklisted), blacklistReason: row.blacklist_reason
      } : { name: '', documentType: 'ID_CARD', documentNo: '', phone: '', address: '', notes: '', blacklisted: false, blacklistReason: '' }
      this.guestDialog = true
    },
    async saveGuest() {
      const result = await this.run(() => unwrap(window.hotelAPI.guests.save({ ...this.guestForm })), '客户档案已保存')
      if (!result) return
      this.guestDialog = false
      await this.refreshAll()
    },

    openCheckIn(room) {
      if (!this.guests.length) {
        ElMessage.warning('请先登记至少一位客户')
        this.openGuest()
        return
      }
      this.checkInRoom = room
      this.checkInForm = {
        guestId: null,
        actualCheckin: new Date(),
        expectedCheckout: futureDate(1, this.settings.defaultCheckoutHour ?? 12),
        nightlyRate: room.standard_price_cents / 100,
        deposit: (this.settings.defaultDepositCents || 0) / 100,
        paymentMethod: 'CASH',
        notes: ''
      }
      this.checkInDialog = true
    },
    async submitCheckIn() {
      if (!this.checkInForm.guestId) return ElMessage.warning('请选择主住客户')
      if (!this.checkInForm.actualCheckin || !this.checkInForm.expectedCheckout) return ElMessage.warning('请选择入住和离店时间')
      const result = await this.run(() => unwrap(window.hotelAPI.stays.checkIn({
        roomId: this.checkInRoom.id,
        guestId: this.checkInForm.guestId,
        actualCheckin: this.checkInForm.actualCheckin.toISOString(),
        expectedCheckout: this.checkInForm.expectedCheckout.toISOString(),
        nightlyRateCents: this.toCents(this.checkInForm.nightlyRate),
        depositCents: this.toCents(this.checkInForm.deposit),
        paymentMethod: this.checkInForm.paymentMethod,
        notes: this.checkInForm.notes
      })), '入住办理完成')
      if (!result) return
      this.checkInDialog = false
      await this.refreshAll()
    },

    openReservation() {
      if (!this.guests.length) {
        ElMessage.warning('请先登记至少一位客户')
        this.openGuest()
        return
      }
      if (!this.reservableRooms.length) return ElMessage.warning('当前没有可用于预订的启用房间')
      const firstRoom = this.reservableRooms[0]
      this.reservationForm = {
        roomId: firstRoom.id, guestId: null,
        expectedCheckin: futureDate(1, this.settings.defaultCheckinHour ?? 14), expectedCheckout: futureDate(2, this.settings.defaultCheckoutHour ?? 12),
        nightlyRate: firstRoom.standard_price_cents / 100, deposit: (this.settings.defaultDepositCents || 0) / 100,
        paymentMethod: 'CASH', source: 'PHONE', notes: ''
      }
      this.reservationDialog = true
    },
    syncReservationRate(roomId) {
      const room = this.rooms.find((item) => item.id === roomId)
      if (room) this.reservationForm.nightlyRate = room.standard_price_cents / 100
    },
    async submitReservation() {
      if (!this.reservationForm.roomId || !this.reservationForm.guestId) return ElMessage.warning('请选择房间和客户')
      if (!this.reservationForm.expectedCheckin || !this.reservationForm.expectedCheckout) return ElMessage.warning('请选择预计到店和离店时间')
      const result = await this.run(() => unwrap(window.hotelAPI.stays.createReservation({
        roomId: this.reservationForm.roomId,
        guestId: this.reservationForm.guestId,
        expectedCheckin: this.reservationForm.expectedCheckin.toISOString(),
        expectedCheckout: this.reservationForm.expectedCheckout.toISOString(),
        nightlyRateCents: this.toCents(this.reservationForm.nightlyRate),
        depositCents: this.toCents(this.reservationForm.deposit),
        paymentMethod: this.reservationForm.paymentMethod,
        source: this.reservationForm.source,
        notes: this.reservationForm.notes
      })), '预订创建成功')
      if (!result) return
      this.reservationDialog = false
      this.stayStatus = 'RESERVED'
      await this.refreshAll()
    },
    async checkInReservation(row) {
      try { await ElMessageBox.confirm(`确认客户“${row.contact_name}”现在入住 ${row.room_no}？`, '预订转入住', { type: 'success' }) } catch (_) { return }
      const result = await this.run(() => unwrap(window.hotelAPI.stays.checkInReservation({ orderId: row.id, actualCheckin: new Date().toISOString() })), '预订已转为入住')
      if (!result) return
      this.stayDrawer = false
      this.stayStatus = 'CHECKED_IN'
      await this.refreshAll()
    },
    async cancelReservation(row) {
      let response
      try { response = await ElMessageBox.prompt(`请输入取消订单 ${row.order_no} 的原因。已收定金会同步登记退款。`, '取消预订', { inputPattern: /\S+/, inputErrorMessage: '取消原因不能为空', type: 'warning' }) } catch (_) { return }
      let bill = this.selectedStay?.id === row.id ? this.selectedBill : null
      try { if (!bill) bill = await unwrap(window.hotelAPI.stays.bill(row.id)) } catch (error) { return ElMessage.error(error.message) }
      const originalMethod = bill.payments.find((item) => item.direction === 'RECEIPT')?.method || 'CASH'
      const result = await this.run(() => unwrap(window.hotelAPI.stays.cancelReservation({ orderId: row.id, reason: response.value, method: originalMethod })), '预订已取消，相关定金已登记退款')
      if (!result) return
      this.stayDrawer = false
      await this.refreshAll()
    },

    async openStayByOrder(orderId) {
      try {
        const activeStays = await unwrap(window.hotelAPI.stays.list(''))
        const stay = activeStays.find((item) => item.id === orderId)
        if (!stay) throw new Error('未找到对应订单')
        await this.openStay(stay)
      } catch (error) { ElMessage.error(error.message) }
    },
    async openStay(row) {
      this.selectedStay = row
      try {
        this.selectedBill = await unwrap(window.hotelAPI.stays.bill(row.id))
        this.stayDrawer = true
      } catch (error) { ElMessage.error(error.message) }
    },
    async refreshSelectedBill() {
      if (!this.selectedStay) return
      this.selectedBill = await unwrap(window.hotelAPI.stays.bill(this.selectedStay.id))
    },
    openCharge() {
      this.chargeForm = { type: 'SERVICE', description: '', amount: 0 }
      this.chargeDialog = true
    },
    async submitCharge() {
      const result = await this.run(() => unwrap(window.hotelAPI.stays.addCharge({
        orderId: this.selectedStay.id,
        type: this.chargeForm.type,
        description: this.chargeForm.description,
        amountCents: this.toCents(this.chargeForm.amount)
      })), '费用流水已添加')
      if (!result) return
      this.chargeDialog = false
      await this.refreshSelectedBill()
      await this.refreshAll()
    },
    async voidCharge(charge) {
      let response
      try { response = await ElMessageBox.prompt(`请输入作废“${charge.description}”的原因`, '作废费用', { inputPattern: /\S+/, inputErrorMessage: '作废原因不能为空', type: 'warning' }) } catch (_) { return }
      const result = await this.run(() => unwrap(window.hotelAPI.stays.voidCharge({
        orderId: this.selectedStay.id, chargeId: charge.id, reason: response.value
      })), '费用已作废，原记录已保留')
      if (!result) return
      await this.refreshSelectedBill()
      await this.refreshAll()
    },
    openCollect() {
      const suggested = Math.max(0, this.selectedBill?.balanceCents || 0) / 100
      this.collectForm = { amount: suggested, purpose: this.selectedStay?.status === 'RESERVED' ? 'DEPOSIT' : 'ROOM', method: 'CASH', notes: '' }
      this.collectDialog = true
    },
    async submitCollect() {
      const result = await this.run(() => unwrap(window.hotelAPI.stays.collect({
        orderId: this.selectedStay.id,
        amountCents: this.toCents(this.collectForm.amount),
        purpose: this.collectForm.purpose,
        method: this.collectForm.method,
        notes: this.collectForm.notes
      })), '收款流水已登记')
      if (!result) return
      this.collectDialog = false
      await this.refreshSelectedBill()
      await this.refreshAll()
    },
    async refundPayment(payment) {
      let amountResponse
      try {
        amountResponse = await ElMessageBox.prompt('请输入本次退款金额（元）', '登记退款', {
          inputValue: this.money(payment.refundable_cents),
          inputPattern: /^\d+(\.\d{1,2})?$/,
          inputErrorMessage: '请输入最多两位小数的正确金额',
          type: 'warning'
        })
      } catch (_) { return }
      let reasonResponse
      try { reasonResponse = await ElMessageBox.prompt('请输入退款原因', '登记退款', { inputPattern: /\S+/, inputErrorMessage: '退款原因不能为空', type: 'warning' }) } catch (_) { return }
      const result = await this.run(() => unwrap(window.hotelAPI.stays.refund({
        orderId: this.selectedStay.id,
        paymentId: payment.id,
        amountCents: this.toCents(Number(amountResponse.value)),
        method: payment.method,
        reason: reasonResponse.value
      })), '退款流水已登记')
      if (!result) return
      await this.refreshSelectedBill()
      await this.refreshAll()
    },
    openExtend() {
      const current = new Date(this.selectedStay.expected_checkout)
      current.setDate(current.getDate() + 1)
      this.extendForm = { expectedCheckout: current }
      this.extendDialog = true
    },
    async submitExtend() {
      if (!this.extendForm.expectedCheckout) return ElMessage.warning('请选择新的离店时间')
      const result = await this.run(() => unwrap(window.hotelAPI.stays.extend({
        orderId: this.selectedStay.id,
        expectedCheckout: this.extendForm.expectedCheckout.toISOString()
      })), '续住办理完成')
      if (!result) return
      this.extendDialog = false
      this.selectedStay.expected_checkout = result.expectedCheckout
      await this.refreshSelectedBill()
      await this.refreshAll()
    },
    openChangeRoom() {
      if (!this.changeableRooms.length) return ElMessage.warning('当前没有空闲、干净且正常的目标房间')
      const room = this.changeableRooms[0]
      this.changeRoomForm = { roomId: room.id, nightlyRate: room.standard_price_cents / 100, sameDayRateMode: 'NEW', reason: '' }
      this.changeRoomDialog = true
    },
    syncChangeRoomRate(roomId) {
      const room = this.rooms.find((item) => item.id === roomId)
      if (room) this.changeRoomForm.nightlyRate = room.standard_price_cents / 100
    },
    async submitChangeRoom() {
      if (!this.changeRoomForm.roomId || !this.changeRoomForm.reason.trim()) return ElMessage.warning('请选择目标房间并填写换房原因')
      const result = await this.run(() => unwrap(window.hotelAPI.stays.changeRoom({
        orderId: this.selectedStay.id,
        roomId: this.changeRoomForm.roomId,
        changeAt: new Date().toISOString(),
        nightlyRateCents: this.toCents(this.changeRoomForm.nightlyRate),
        sameDayRateMode: this.changeRoomForm.sameDayRateMode,
        reason: this.changeRoomForm.reason
      })), '换房办理完成，原房已转待清洁')
      if (!result) return
      this.changeRoomDialog = false
      await this.refreshAll()
      const updated = this.stays.find((item) => item.id === this.selectedStay.id)
      if (updated) this.selectedStay = updated
      await this.refreshSelectedBill()
    },
    openAddGuest() {
      if (!this.availableStayGuests.length) return ElMessage.warning('没有其他可添加的客户，请先登记客户档案')
      this.addGuestForm = { guestId: null }
      this.addGuestDialog = true
    },
    async submitAddGuest() {
      if (!this.addGuestForm.guestId) return ElMessage.warning('请选择同住客户')
      const result = await this.run(() => unwrap(window.hotelAPI.stays.addGuest({ orderId: this.selectedStay.id, guestId: this.addGuestForm.guestId })), '同住人已添加')
      if (!result) return
      this.addGuestDialog = false
      await this.refreshSelectedBill()
    },
    async removeStayGuest(guest) {
      try { await ElMessageBox.confirm(`确认移除同住人“${guest.name}”？`, '移除入住人', { type: 'warning' }) } catch (_) { return }
      const result = await this.run(() => unwrap(window.hotelAPI.stays.removeGuest({ orderId: this.selectedStay.id, guestId: guest.id })), '同住人已移除')
      if (result) await this.refreshSelectedBill()
    },
    reportFilters() {
      let start, end
      if (this.reportTimeRange === 'custom') {
        [start, end] = this.reportDates || []
      } else if (this.reportTimeRange === 'current_month') {
        const now = new Date()
        start = new Date(now.getFullYear(), now.getMonth(), 1)
        end = now
      } else if (this.reportTimeRange === 'last_week') {
        const now = new Date()
        const dayOfWeek = now.getDay() || 7
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek + 1)
        end = now
      } else if (this.reportTimeRange === 'last_month') {
        const now = new Date()
        const lastMonth = now.getMonth() - 1
        start = new Date(now.getFullYear(), lastMonth, 1)
        end = new Date(now.getFullYear(), lastMonth + 1, 0)
      } else if (this.reportTimeRange === 'selected_month') {
        const month = this.reportMonth || new Date()
        start = new Date(month.getFullYear(), month.getMonth(), 1)
        end = new Date(month.getFullYear(), month.getMonth() + 1, 0)
      }
      return { startDate: localDateKey(start || new Date()), endDate: localDateKey(end || new Date()) }
    },
    async loadReport() {
      try { this.reportRows = await unwrap(window.hotelAPI.reports.daily(this.reportFilters())) } catch (error) { ElMessage.error(error.message) }
    },
    async exportReport() {
      const result = await this.run(() => unwrap(window.hotelAPI.reports.exportDaily(this.reportFilters())))
      if (result && !result.canceled) ElMessage.success(`报表已导出：${result.filePath}`)
    },
    async saveSettings() {
      const result = await this.run(() => unwrap(window.hotelAPI.settings.save({
        ...this.settingsForm,
        defaultDepositCents: this.toCents(this.settingsForm.defaultDeposit)
      })), '系统设置已保存')
      if (!result) return
      this.settings = result
      this.settingsForm = { ...result, defaultDeposit: result.defaultDepositCents / 100 }
    },
    async openCheckout() {
      this.checkoutAt = new Date()
      try {
        this.checkoutBill = await unwrap(window.hotelAPI.stays.bill(this.selectedStay.id, this.checkoutAt.toISOString()))
        this.checkoutForm = { method: 'CASH' }
        this.checkoutDialog = true
      } catch (error) { ElMessage.error(error.message) }
    },
    async submitCheckout() {
      if (!this.checkoutBill) return
      const result = await this.run(() => unwrap(window.hotelAPI.stays.checkOut({
        orderId: this.selectedStay.id,
        checkoutAt: this.checkoutAt.toISOString(),
        settlementAmountCents: Math.abs(this.checkoutBill.balanceCents),
        method: this.checkoutForm.method
      })), '退房结算完成，房间已转为待清洁')
      if (!result) return
      this.checkoutDialog = false
      this.stayDrawer = false
      await this.refreshAll()
    },

    async createBackup() {
      const result = await this.run(() => unwrap(window.hotelAPI.backup.create()))
      if (result && !result.canceled) ElMessage.success(`备份已保存：${result.filePath}`)
    },
    async restoreBackup() {
      try { await ElMessageBox.confirm('恢复会覆盖当前数据。系统会先自动保存当前数据库，是否继续？', '恢复备份', { type: 'warning', confirmButtonText: '继续恢复' }) } catch (_) { return }
      const result = await this.run(() => unwrap(window.hotelAPI.backup.restore()))
      if (!result || result.canceled) return
      ElMessage.success('数据恢复完成，请使用备份中的账号重新登录')
      if (result.requiresLogin) await this.initializeAuth()
    }
  }
}).use(ElementPlus, { locale: ElementPlusLocaleZhCn }).mount('#app')
