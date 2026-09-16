# vite-plugin-electron multi-environment example

A minimal project using `electronSimple` from `vite-plugin-electron/multi-env`, Vite, Electron, Zod schemas and React.

From the repository root:

```bash
pnpm build
cd examples/vite-plugin-electron-multi-env
pnpm install
pnpm dev
```

Run `pnpm build` in this directory to typecheck and build the application with `vite build --app`.

## Vite configuration

- Renderer uses the `client` environment; Electron uses `electron_main` and `electron_preload`.
- `builder.sharedConfigBuild: true` preserves the shared IPC session across the production environment builds.
- The renderer IPC plugin belongs in the top-level `plugins`. Main and preload IPC plugins belong in their respective `electronSimple` options, where `plugins` maps to bundler plugins. This also supplies them to the separate Electron builder used during development.
- `electronSimple` builds the renderer before the Electron environments in production, so main and preload receive the retained channel selection.

Edit `electron/custom.ipc.ts` to change the implementation. The plugin discovers `.ipc.ts` files anywhere under the Vite root by default; use `include` and `exclude` to customize the scope. The IPC plugins regenerate the affected outputs, including new/deleted definitions and channel renames. `vite-plugin-electron` manages Electron restart and window reload.

When changing the library itself, rebuild it and reinstall the example's local file dependency before restarting the example.
