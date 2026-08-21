const { contextBridge, ipcRenderer } = require('electron')

// Vue 表单是响应式 Proxy，Electron IPC 无法直接结构化克隆。
// 所有业务参数在安全边界统一转换成只包含 JSON 数据的普通对象。
const toPlainData = (payload) => {
  if (payload === undefined) return undefined
  return JSON.parse(JSON.stringify(payload))
}

const invoke = (channel, payload) => ipcRenderer.invoke(channel, toPlainData(payload))

contextBridge.exposeInMainWorld('hotelAPI', Object.freeze({
  app: Object.freeze({ version: () => invoke('app:version') }),
  auth: Object.freeze({
    status: () => invoke('auth:status'),
    register: (data) => invoke('auth:register', data),
    login: (data) => invoke('auth:login', data),
    logout: () => invoke('auth:logout'),
    updateProfile: (data) => invoke('auth:update-profile', data),
    changePassword: (data) => invoke('auth:change-password', data)
  }),
  dashboard: Object.freeze({ get: () => invoke('dashboard:get') }),
  roomTypes: Object.freeze({
    list: (includeDisabled = true) => invoke('room-types:list', { includeDisabled }),
    save: (data) => invoke('room-types:save', data),
    toggle: (id, enabled) => invoke('room-types:toggle', { id, enabled })
  }),
  rooms: Object.freeze({
    list: () => invoke('rooms:list'),
    save: (data) => invoke('rooms:save', data),
    toggle: (id, enabled) => invoke('rooms:toggle', { id, enabled }),
    markClean: (id) => invoke('rooms:mark-clean', { id }),
    setMaintenance: (id, enabled, reason = '') => invoke('rooms:maintenance', { id, enabled, reason })
  }),
  guests: Object.freeze({
    list: (keyword = '') => invoke('guests:list', { keyword }),
    save: (data) => invoke('guests:save', data),
    exportCsv: () => invoke('guests:export'),
    importCsv: () => invoke('guests:import')
  }),
  stays: Object.freeze({
    list: (status = '', keyword = '') => invoke('stays:list', { status, keyword }),
    checkIn: (data) => invoke('stays:check-in', data),
    createReservation: (data) => invoke('stays:create-reservation', data),
    checkInReservation: (data) => invoke('stays:check-in-reservation', data),
    cancelReservation: (data) => invoke('stays:cancel-reservation', data),
    bill: (orderId, checkoutAt = null) => invoke('stays:bill', { orderId, checkoutAt }),
    addCharge: (data) => invoke('stays:add-charge', data),
    voidCharge: (data) => invoke('stays:void-charge', data),
    collect: (data) => invoke('stays:collect', data),
    refund: (data) => invoke('stays:refund', data),
    checkOut: (data) => invoke('stays:check-out', data),
    extend: (data) => invoke('stays:extend', data),
    changeRoom: (data) => invoke('stays:change-room', data),
    addGuest: (data) => invoke('stays:add-guest', data),
    removeGuest: (data) => invoke('stays:remove-guest', data)
  }),
  logs: Object.freeze({ list: (filters = {}) => invoke('logs:list', filters) }),
  settings: Object.freeze({
    get: () => invoke('settings:get'),
    save: (data) => invoke('settings:save', data)
  }),
  reports: Object.freeze({
    daily: (filters) => invoke('reports:daily', filters),
    exportDaily: (filters) => invoke('reports:export-daily', filters)
  }),
  backup: Object.freeze({
    create: () => invoke('backup:create'),
    restore: () => invoke('backup:restore')
  })
}))
