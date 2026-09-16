import path from "node:path"
import { fileURLToPath } from "node:url"
import { app, BrowserWindow } from "electron"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rendererFile = path.resolve(__dirname, "../dist/index.html")
const devServerUrl = process.env.VITE_DEV_SERVER_URL

function createWindow() {
	const win = new BrowserWindow({
		width: 900,
		height: 670,
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	})
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))

	if (devServerUrl) {
		void win.loadURL(devServerUrl)
	} else {
		void win.loadFile(rendererFile)
	}
}

app.whenReady().then(() => {
	createWindow()
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow()
	})
})

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit()
})
