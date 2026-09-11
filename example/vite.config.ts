import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import electron from "vite-plugin-electron/simple"
import { ipcInvoke } from "electron-ipc-invoke/vite"

export default defineConfig(() => {
	const ipc = ipcInvoke()

	return {
		plugins: [
			react(),
			ipc.renderer(),
			electron({
				main: {
					entry: "electron/main.ts",
					vite: { plugins: [ipc.main()] },
				},
				preload: {
					input: "electron/preload.ts",
					vite: { plugins: [ipc.preload()] },
				},
			}),
		],
	}
})
