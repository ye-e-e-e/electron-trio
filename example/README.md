# electron-ipc-invoke example

A minimal project using Vite 8.2.0+, Electron 44.0.0+, [vite-plugin-electron](https://github.com/electron-vite/vite-plugin-electron), Zod schema and React.

To run this example:
```bash
pnpm install
pnpm dev
```

Edit `electron/custom.ipc.ts` to change the implementation. The plugin discovers `.ipc.ts` files anywhere under the Vite root by default; use `include` and `exclude` to customize the scope. The IPC plugins regenerate the affected outputs, including new/deleted definitions and channel renames. `vite-plugin-electron` manages Electron restart and window reload.

When changing the library itself, rebuild it and reinstall the example's local file dependency before restarting the example.
