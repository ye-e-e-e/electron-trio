import { app, BrowserWindow } from 'electron'
import { loadWindow } from 'electron-trio'
import preload from './preload'
import { windowTitle } from './window-title'

let title = windowTitle

function createWindow() {
  const win = new BrowserWindow({
    title,
    width: 900,
    height: 670,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('page-title-updated', (event) => event.preventDefault())
  void loadWindow(win)
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

if (import.meta.hot) {
  import.meta.hot.accept('./window-title', (module) => {
    if (!module) return
    title = module.windowTitle
    for (const win of BrowserWindow.getAllWindows()) win.setTitle(title)
  })
}
