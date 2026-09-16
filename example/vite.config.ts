import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import electron from "vite-plugin-electron/simple"
import { ipcInvoke } from "electron-ipc-invoke/vite"

export default defineConfig(() => {
	const [renderer, main, preload] = ipcInvoke()

	return {
		plugins: [
			react(),
			renderer,
			electron({
				main: {
					entry: "electron/main.ts",
					vite: { plugins: [main] },
				},
				preload: {
					input: "electron/preload.ts",
					vite: { plugins: [preload] },
				},
			}),
		],
	}
})
