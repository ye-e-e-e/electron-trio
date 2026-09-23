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

Edit `electron/custom.ts` to change the implementation. Definitions are discovered from imported modules; no filename suffix or glob configuration is required. Development calls from renderer and main share a ModuleRunner in the Electron main process. Changes to managed definitions and their dependencies take effect without rebuilding main/preload or restarting Electron. An invalid update rejects new calls until repaired.

Ordinary main/preload entry changes continue to use the Electron integration's normal rebuild behavior. Ordinary helpers imported outside the runner do not share runner module state. The IPC module runner does not provide `import.meta.hot` or module disposal callbacks. Manage persistent resources in main-process services that are not reloaded with IPC implementations. Externalized dependencies are not guaranteed to hot-update.
