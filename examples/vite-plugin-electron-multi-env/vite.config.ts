import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { electronSimple } from "vite-plugin-electron/multi-env"
import { ipcInvoke } from "electron-ipc-invoke/vite"

export default defineConfig(() => {
	const [renderer, main, preload] = ipcInvoke()

	return {
		builder: { sharedConfigBuild: true },
		plugins: [
			react(),
			renderer,
			electronSimple({
				main: {
					input: "electron/main.ts",
					plugins: [main],
				},
				preload: {
					input: "electron/preload.ts",
					plugins: [preload],
				},
			}),
		],
	}
})
