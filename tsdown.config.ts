import { defineConfig } from "tsdown"

export default defineConfig({
	entry: ["src/index.ts", "src/renderer.ts", "src/vite.ts"],
	format: "esm",
	target: "es2022",
	dts: true,
	exports: true,
})
