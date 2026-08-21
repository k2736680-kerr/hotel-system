const { app, BrowserWindow, Menu, session, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { HotelDatabase } = require('./src/main/database')
const { HotelService } = require('./src/main/hotel-service')
const { registerIpcHandlers } = require('./src/main/ipc')

let mainWindow = null
let database = null
let applicationUserDataPath = null
let automaticBackupTimer = null

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function createAutomaticBackup(userDataPath, force = false) {
  const directory = path.join(userDataPath, 'backups')
  fs.mkdirSync(directory, { recursive: true })
  const targetPath = path.join(directory, 'auto-latest.sqlite')
  for (const fileName of fs.readdirSync(directory)) {
    if (fileName.startsWith('auto-') && fileName.endsWith('.sqlite') && fileName !== 'auto-latest.sqlite') {
      fs.rmSync(path.join(directory, fileName))
    }
  }
  if (!force && fs.existsSync(targetPath)) {
    const backupDate = localDateKey(fs.statSync(targetPath).mtime)
    if (backupDate === localDateKey(new Date())) return targetPath
  }
  database.backupTo(targetPath)
  return targetPath
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 720,
    title: '酒店管家',
    show: false,
    backgroundColor: '#f3f6fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  mainWindow.loadFile(path.join(__dirname, 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.on('closed', () => { mainWindow = null })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    try {
      const userDataPath = app.getPath('userData')
      applicationUserDataPath = userDataPath
      database = await HotelDatabase.open(path.join(userDataPath, 'data', 'hotel.sqlite'))
      const service = new HotelService(database)
      try { createAutomaticBackup(userDataPath) } catch (error) { console.error('Automatic backup failed:', error) }
      automaticBackupTimer = setInterval(() => {
        if (!database) return
        try { createAutomaticBackup(userDataPath) } catch (error) { console.error('Scheduled backup failed:', error) }
      }, 60 * 60 * 1000)
      automaticBackupTimer.unref()
      registerIpcHandlers({ service, database, userDataPath, getWindow: () => mainWindow })

      Menu.setApplicationMenu(null)
      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
      createWindow()
    } catch (error) {
      console.error('Application initialization failed:', error)
      dialog.showErrorBox('酒店管家启动失败', `无法打开本地数据库：${error.message}\n\n请保留数据目录并联系维护人员。`)
      app.quit()
    }
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (!mainWindow && database) createWindow()
})

app.on('before-quit', () => {
  if (!database) return
  if (automaticBackupTimer) clearInterval(automaticBackupTimer)
  try { createAutomaticBackup(applicationUserDataPath, true) } catch (error) { console.error('Exit backup failed:', error) }
  database.close()
  database = null
})

process.on('uncaughtException', (error) => console.error('Uncaught exception:', error))
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error))
