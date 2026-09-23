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

Edit `electron/custom.ts` to change the implementation. Definitions are discovered from imported modules; no filename suffix or glob configuration is required. Development calls from renderer and main share a ModuleRunner in the Electron main process. Changes to managed definitions and their dependencies take effect without rebuilding main/preload or restarting Electron. An invalid update rejects new calls until repaired.

Ordinary main/preload entry changes continue to use the Electron integration's normal rebuild behavior. Ordinary helpers imported outside the runner do not share runner module state. The IPC module runner does not provide `import.meta.hot` or module disposal callbacks. Manage persistent resources in main-process services that are not reloaded with IPC implementations. Externalized dependencies are not guaranteed to hot-update.
