import { defineConfig } from "tsdown"

export default defineConfig({
	entry: { index: "src/index.ts", vite: "src/vite.ts", dev: "src/dev.ts" },
	format: "esm",
	target: "es2022",
	dts: true,
	exports: true,
})
