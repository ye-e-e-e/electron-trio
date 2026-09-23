# Repository Guidelines

## Project Structure & Module Organization

`electron-ipc-invoke` is a TypeScript ESM library that generates type-safe Electron IPC wiring through Vite plugins.

The source separates definition compilation, shared plugin context, Vite integration, and Electron runtime code:

```text
src/
├── index.ts, vite.ts, dev.ts      Public package entries
├── constants.ts                  Shared handler identifier and dev runtime import path
├── compiler/                     Definition analysis, registry, and source contracts
│   ├── analyzer.ts
│   ├── registry.ts
│   ├── source-contract.ts
│   └── types.ts
├── context/                      State shared by renderer, main, and preload plugins
│   ├── context.ts                PluginContext and default bridge name
│   ├── types.ts                  Context options and build targets
│   ├── definition-sources.ts     Discovered definition files and caller sources
│   └── build-signals.ts          Production watch coordination
├── runtime/                      Code executed inside Electron main
│   ├── index.ts                  Shared runtime initialization and access
│   ├── ipc-runtime.ts            IPC execution instance, connection, module cache, and cleanup
│   └── protocol.ts              Development connection and message types
└── vite/
    ├── plugin.ts                 Plugin assembly
    ├── types.ts                  Public plugin options and return type
    ├── renderer-proxy-plugin/    plugin.ts, renderer-module.ts
    ├── main-proxy-plugin/        plugin.ts, constants.ts
    ├── preload-check-plugin/     plugin.ts
    ├── manifest-plugin/          plugin.ts, manifest-collector.ts
    ├── ipc-provider-plugin/      plugin.ts, environment.ts, rpc-server.ts
    └── entry-plugin/             plugin.ts, main-module.ts, preload-module.ts, constants.ts
```

`src/index.ts` exports the definition API; `src/vite.ts` exports the Vite integration. `src/dev.ts` and `src/runtime/index.ts` export only `initRuntime` and `getRuntime`. The returned instance provides `invoke` and `close`; the instance factory is internal. Closing an instance does not replace it or reset initialization. Renderer invokers are provided by the renderer proxy plugin's virtual module.

`PluginContext` shares the definition registry, discovered files and caller sources, production manifest, and development connection information. `BuildSignals` coordinates production watch builds through temporary signal files. `ipcProviderPlugin` configures an `IpcEnvironment` and connects Vite hooks to it. The environment owns dependency tracking, source updates, invocation validation, and the RPC server lifecycle. It subscribes to discovered files during initialization and releases the subscription and RPC server when it closes. `rpc-server.ts` handles WebSocket authentication and request/response framing; it does not manage modules. There is no separate definition lookup RPC or proactive runtime reload.

Keep generated initialization code in `entry-plugin/`, main function proxy generation in `main-proxy-plugin/`, and reusable Electron runtime code in `runtime/`. Main proxies use `getRuntime` from `electron-ipc-invoke/dev`; entry initialization uses the same shared runtime and owns IPC registration, `initRuntime` with connection parameters, and instance `close()` on quit. Proxies can be created before initialization; initialize the shared runtime before application code invokes them.

Development main imports resolve to virtual modules with static function exports. Development renderer and main callers both use module paths and export names, independently of channel names. IPC implementation changes invalidate the provider cache without rebuilding main or preload. The next module request updates the runner; module replacement waits for active handlers, and unrelated module instances stay cached. The runner uses invoke-only RPC with HMR disabled and does not expose `import.meta.hot` or manage user module disposal. Export additions and removals appear on the next main build; ordinary namespace imports, reexports, and dynamic imports are handled by Vite without custom namespace rewriting.

`preloadCheckPlugin` validates preload source modules and rejects IPC implementation imports in both development and production. `entryPlugin` owns entry validation, initialization module generation and injection, production watch subscriptions, and the main build's manifest consistency and channel conflict checks. Manifest publication already checks channel uniqueness before main and preload consume it.

`examples/vite-plugin-electron/` and `examples/vite-plugin-electron-multi-env/` are React/Electron applications using the simple and multi-environment integrations. Each has renderer code in `src/` and main/preload code in `electron/`.

`dist/` contains generated bundles and declarations; do not edit it directly.

## Build, Test, and Development Commands

Use pnpm `10.33.4` and Node.js matching `^20.19.0 || >=22.12.0`, as declared in `package.json`.

- `pnpm install`: install dependencies and initialize Husky hooks.
- `pnpm dev`: rebuild the library on changes using tsdown.
- `pnpm build`: generate ESM bundles and TypeScript declarations.
- `pnpm typecheck`: check source, tests, and compile-time assertions without emitting files.
- `pnpm test` / `pnpm test:watch`: run the default suite once or in watch mode.
- `pnpm test:package`: build and test the distributable package.
- `ELECTRON_BINARY=/path/to/electron pnpm test:electron`: build and run real Electron integration tests.

To run an example, build the library, then run `pnpm install` and `pnpm dev` inside its directory under `examples/`. Rebuild the library and reinstall the example’s local dependency after library changes.

## Coding Style & Naming Conventions

Use strict TypeScript and explicit type-only imports. Match nearby formatting: source and tests generally use two spaces, single quotes, and no semicolons; some configuration files use tabs and double quotes. No formatter or code linter is configured.

Use camelCase for functions and variables, PascalCase for types and classes, and descriptive kebab-case module filenames. Use `#/...` for source imports that would traverse parent directories; keep `./...` imports relative. Omit file extensions in both forms. Plugin directories use `<name>-plugin` with a `plugin.ts` entry; supporting modules are named by their responsibility. IPC definitions are identified by their exports, without a required filename suffix.

Shared plugin identifiers belong in their owning plugin's `constants.ts`, and consumers import them from there. `src/constants.ts` holds the shared `HANDLER_KEY` and `DEV_RUNTIME_IMPORT`. Keep file-local constants beside their use, including `DEFAULT_BRIDGE_NAME` in `src/context/context.ts`.

## Testing Guidelines

`tests/compiler/`, `tests/context/`, `tests/vite/`, and `tests/runtime/` follow the source boundaries. `tests/electron/` and `tests/package/` are separate integration suites; `tests/prototypes/` contains feasibility tests.

Name suites `tests/<area>/*.test.ts` and describe observable behavior in test names. Reuse `tests/helpers.ts` for temporary fixtures and cleanup. Add type assertions to `tests/types.ts` when changing inference. No coverage threshold is configured. Default tests exclude `tests/package/` and `tests/electron/`; run those separately when changing packaging or process integration.

## Commit & Pull Request Guidelines

Commitlint enforces Conventional Commits, such as `fix: handle renamed IPC channels`; the pre-commit hook runs typechecking.

Keep pull requests focused. Describe the behavior change, link relevant issues, and report validation commands and results. Update both README languages when changing documented APIs or usage.
