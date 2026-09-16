# vite-plugin-electron example

A minimal project using `vite-plugin-electron/simple`, Vite, Electron, Zod schemas and React. Main and preload use separate Vite builds.

From the repository root:

```bash
pnpm build
cd examples/vite-plugin-electron
pnpm install
pnpm dev
```

Run `pnpm build` in this directory to build renderer, main and preload for production.

Edit `electron/custom.ipc.ts` to change the implementation. The plugin discovers `.ipc.ts` files anywhere under the Vite root by default; use `include` and `exclude` to customize the scope. The IPC plugins regenerate the affected outputs, including new/deleted definitions and channel renames. `vite-plugin-electron` manages Electron restart and window reload.

When changing the library itself, rebuild it and reinstall the example's local file dependency before restarting the example.
