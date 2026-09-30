# Repository Guidelines

## Project Structure & Module Organization

`electron-trio` is a Vite-based tool for developing and building Electron applications, implemented as a TypeScript ESM library. It manages Electron processes during development, coordinates renderer/main/preload builds, generates type-safe IPC wiring, and provides preload import and page-loading APIs.

The source separates definition compilation, Vite integration, and Electron runtime code:

```text
src/
├── index.ts, vite.ts              Public API and plugin entries
├── api/                          Public API implementations
│   ├── create-ipc-invoke.ts        IPC definitions, validation error, and public types
│   ├── create-preload.ts           createPreload compile-time API
│   └── load-window.ts              Development URL and production renderer loading
├── constants.ts                  Shared handler identifier and implementation query
├── compiler/                     Definition analysis and symbol resolution
│   ├── source-module.ts          AST, local bindings, and source locations
│   ├── symbol-resolver.ts        Direct imports and local alias resolution
│   ├── ipc-analyzer.ts           IPC call chains and export contracts
│   ├── preload-analyzer.ts       createPreload calls and entry contracts
│   └── types.ts
├── runtime/                      Code executed inside Electron main
│   ├── ipc-dispatcher.ts         IPC target validation and invocation dispatch
│   ├── bootstrap.ts             Creates the runner and imports main
│   ├── connection.ts            Child-side runner transport and validation requests
│   └── protocol.ts              Shared bootstrap config, process messages, validation events
└── vite/
    ├── plugin.ts                 Plugin assembly
    ├── types.ts                  Public plugin input configuration
    ├── constants.ts              Shared environment names and source module ID filter
    ├── output-paths.ts           Relocatable ES/CommonJS paths for generated main code
    ├── load-window-plugin/       Production renderer path placeholder replacement
    ├── ipc-plugin/               IPC plugin assembly, independent of Electron process control
    │   ├── plugin.ts             Creates IpcContext and assembles IPC plugins
    │   ├── context.ts            State shared by renderer, main, and preload IPC plugins
    │   ├── types.ts              Shared IPC options
    │   ├── ipc-registry.ts        Definition state, discovery, callers, and analysis cache
    │   ├── module-id.ts           IPC source identity without Vite queries
    │   └── manifest.ts           Immutable production manifest
    ├── ipc-renderer-plugin/      plugin.ts, renderer-module.ts
    ├── ipc-main-plugin/          Development main calling proxy transforms
    ├── ipc-dispatcher-plugin/    plugin.ts, constants.ts, dispatcher-module.ts
    ├── ipc-protection-plugin/    Preload IPC import protection
    ├── ipc-manifest-plugin/      plugin.ts, manifest-collector.ts
    ├── electron-plugin/          plugin.ts, environment.ts, process.ts, hot-channel.ts, types.ts
    ├── preload-plugin/           plugin.ts, environment.ts
    ├── preload-path-plugin/      plugin.ts, builds.ts
    ├── preload-entry-plugin/     plugin.ts, module-side-effects.ts
    ├── ipc-provider-plugin/      plugin.ts, provider.ts
    └── ipc-entry-plugin/         plugin.ts, host-entry.ts, main-module.ts, preload-module.ts, constants.ts
```

`src/index.ts` reexports the IPC definition API, its public types, `createPreload`, and `loadWindow` from `src/api/`; `src/vite.ts` exports `electronTrio` and `ElectronTrioViteOptions` through `electron-trio/vite`. There is no public `electron-trio/dev` entry. The internal IPC dispatcher provides `invoke`; the bootstrap creates it and shares it with generated callers. Renderer invokers are provided by the `ipc-renderer-plugin` virtual module.

`loadWindow(window: BrowserWindow)` returns the Electron loading Promise. It loads `VITE_DEV_SERVER_URL` when present, otherwise the client output's `index.html`. Its implementation contains the compile-time identifier `__ELECTRON_TRIO_RENDERER_FILE__`; `load-window-plugin/` replaces it in `renderChunk` using the resolved client `build.outDir`, without a global symbol, virtual configuration module, or main entry initialization. The main environment defaults to `resolve.noExternal: ['electron-trio']` so installed API implementations receive compilation. Production requires bundling the implementation through `electronTrio`; `electron-trio` cannot be explicitly externalized when using this helper in production. Other IPC APIs retain external package support. `output-paths.ts` resolves both renderer and preload paths relative to their containing main chunk for ES and CommonJS output. The public API imports Electron types only; it must not add Node or Electron runtime imports to the root entry.

`SourceModule` owns parsing, direct import bindings, local declarations, and source diagnostics. `SymbolResolver` identifies configured direct imports through namespaces and local immutable aliases without evaluating code. It analyzes only the current module and delegates call-expression semantics to the consumer. `analyzeIpcModule` owns local IPC builder/handler chains and channel validation; `analyzePreloadEntry` owns `createPreload` calls and the default-export contract. Both use the same resolver. The compiler does not load dependencies or follow reexports; there is no analysis host or cross-file analysis dependency cache. Keep API names and API-specific validation out of the shared resolver.

`electronTrio({ entry, bridgeName?, electron? })` returns Vite's `PluginOption`, preserving nested plugin arrays for Vite to resolve. It assembles Electron process/build management, preload import handling, and the IPC layer. There is no `preload.entry` option. Each IPC plugin selects its own `client`, `electron_main`, or `electron_preload` environment. `ipcPlugin` receives IPC options and creates one `IpcContext` internally. `IpcContext` shares the IPC registry, production manifest, and bridge name. `IpcRegistry` in `ipc-plugin/ipc-registry.ts` owns application definition state, discovery subscriptions, caller membership, analysis caching, and lookup validation; source analysis remains in `compiler/`. Successful IPC registration publishes discovery automatically. File deletion invalidates current metadata while retaining discovery and callers; recreation restores invocation only after analysis identifies valid IPC definitions. Explicit caller removal remains distinct from content invalidation. Plugins read Vite command and mode directly from their environment configuration. Watcher resources remain owned by their plugins.

`ProductionManifest` publishes immutable channel/module/export mappings after all renderer outputs succeed. `ipc-manifest-plugin/` owns collection. Vite's top-level `build.outDir` remains the shared output root (default `dist`); application outputs default to its `client`, `main`, and `preload` subdirectories. Explicit environment output overrides are preserved. Production builds run once in client → main order; `vite build --watch` is not supported.

`electron-plugin/` owns the `electron_main` environment configuration, the private process IPC HotChannel, Electron start/restart/stop, and client → main production build ordering through its `buildApp` plugin hook. Its `environment.ts` defines `createElectronEnvironment`, which merges runtime defaults with user environment options; the plugin supplies the entry and output paths and assigns the merged options once. It preserves the application's `builder.buildApp` callback. Its `types.ts` defines `ElectronOptions` with optional `args`; the executable comes from `ELECTRON_BINARY` or the application's installed `electron` package. `electronPlugin` only receives application options. Keep this process/build layer independent of definition analysis. Application aliases, defines, plugins, and build overrides use standard Vite environments.

**Preload assembly and configuration.** `preload-plugin/plugin.ts` creates shared `PreloadBuilderState` and assembles an inline `electron-trio:preload-builder` initialization plugin, `preload-path-plugin/`, and `preload-entry-plugin/`. `preload-plugin/environment.ts` defines `createPreloadEnvironment`, which merges preload defaults with user environment options. The builder plugin supplies the output directory, assigns the merged `electron_preload` options once, and writes `state.builder`; the path plugin supplies a getter for that Builder to its build manager.

**Preload Builder lifecycle.** In development, the builder plugin's `configureServer` creates one Builder from the local config file with fresh plugins and `mode: 'development'`; it does not reuse inline application plugins or overrides. In production, its top-level `buildApp` hook with `order: 'pre'` captures the existing application Builder before the Electron plugin starts client and main builds. Production requires `builder.buildApp()`; calling `builder.build(main)` alone does not initialize the preload builder. Production reuses the application Builder and its existing IPC context and manifest without capturing raw application configuration, creating additional Builders, or rerunning configuration hooks.

**Preload discovery and paths.** `preload-path-plugin/plugin.ts` selects the main environment and recognizes `export default createPreload(callback)` in the code received by its `SOURCE_MODULE_FILTER`-filtered `transform(code, id)` hook. Discovery does not execute user code, intercept resolution, or read source files separately. The configured main entry cannot itself be a preload entry. The plugin delegates independent preload builds and replaces the real source module with a path export or production path marker. The real preload entry ID remains in the main module graph, but its original imports and callback are removed before main import analysis, keeping preload dependencies outside that graph. Default filenames use hashes of project-relative entry paths; production paths resolve relative to the importing main chunk for both CJS and ES output.

**Preload compilation.** `preload-entry-plugin/plugin.ts` selects only the preload environment, validates its entry, and compiles the macro into callback execution. Its `transform` hook reads `this.getModuleInfo(id)?.isEntry` without `buildStart` or per-environment entry state; `HostEntry` separately retains per-environment state for IPC entry injection. The macro uses the shared symbol resolver for direct named and namespace imports from `electron-trio` and immutable local factory aliases. Factories imported through other files are not recognized. Entries must default-export a direct macro call and may additionally export types. Preload entries cannot import other preload entries. Direct macro imports are removed during transformation; unused namespace and alias imports are removed by tree shaking without discarding ordinary dependency side effects. The adjacent `module-side-effects.ts` handles the side-effect-free `electron-trio` API module while preserving native configuration rules and string arrays; only an existing function rule is wrapped. The entry plugin owns no environment defaults or Builder lifecycle.

**Preload build execution.** `preload-path-plugin/builds.ts` defines `PreloadBuilds`, which owns build execution, output validation, caching, and watcher cleanup. Development and production use the same environment preparation: each discovered entry gets a separate `BuildEnvironment` named `electron_preload` from the retained Builder's resolved configuration and plugins, with its own input and output collector. Per-entry input and watch overrides do not mutate the Builder's environment configuration. Configuration is not reloaded for additional entries or watch updates. Builds start on import and main waits for the first successful CommonJS output. Development creates a watcher per entry; an initial watch cycle that ends without a successful bundle rejects the pending import and releases the watcher.

**Preload updates and cleanup.** In development, the generated stable path module self-accepts HMR; the separate preload watcher rebuilds the CommonJS output and reloads windows. The path plugin uses a boolean `applyToEnvironment` filter and top-level hooks. Its `perEnvironmentState` stores entry tracking, the dev flag, path markers, and build manager by actual environment object. Its reload callback calls the owning `ElectronDevEnvironment.electron.reloadWindows()` directly, without a `configureServer` handoff. Each main development environment owns its preload watchers and closes them on shutdown. The path plugin only discovers entries, delegates builds, exposes output paths, and connects reload and close callbacks.

`runtime/connection.ts` supplies the child-side ModuleRunner transport and requests target validation from the provider. `runtime/protocol.ts` defines `ElectronBootstrapConfig`, shared process message types, and validation event names. `electron-plugin/hot-channel.ts` adapts the parent-side process connection to Vite's HotChannel. `createElectronHotChannel()` returns the channel directly and exposes child-process binding through `api.connect(child)`; its `onFullReload` callback restarts Electron. `ElectronProcess.reloadWindows()` only reloads existing windows after a preload rebuild.

`src/runtime/bootstrap.ts` is the direct ESM build entry for the package-internal `dist/bootstrap.mjs` bootstrap and is excluded from package exports. It initializes directly at module scope using top-level await. `electron-plugin/process.ts` locates it relative to the package root. The bootstrap creates one ModuleRunner with HMR and an IPC dispatcher synchronously using that runner. It imports `virtual:electron-trio:ipc-dispatcher` through the runner and calls `setDispatcher(dispatcher)` before awaiting `runner.import(mainEntry)`. Main source must schedule window creation with `app.whenReady().then(...)`, not top-level await readiness in this awaited import chain. Ordinary main dependencies and IPC implementations use the same runner and module graph. Native externalized dependencies remain outside Vite HMR.

Keep generated IPC registration and preload bridge code in `ipc-entry-plugin/`, main function proxy generation in `ipc-main-plugin/`, and Electron-side runner/dispatcher code in `runtime/`. The standalone `ipc-dispatcher-plugin/` serves `virtual:electron-trio:ipc-dispatcher` only in the main development environment and needs no IPC context. Its synchronous `setDispatcher` and `getDispatcher` share the bootstrap-created instance with main proxies and renderer IPC registration. The virtual module stores a reference; it creates no runner or dispatcher. Entry injection only registers IPC; the bootstrap owns initialization. Application shutdown follows Electron's native lifecycle without intercepting cancellable quit events or draining IPC calls. Parent IPC disconnection exits immediately; its listener is installed before asynchronous initialization. Initialization errors are logged and exit with code 1. The runner and dispatcher live until process exit.

Development main and renderer plugins recognize IPC definitions in `transform` and replace ordinary module IDs with static calling exports. The shared dispatcher imports the same source with `?ipc-implementation` to load the implementation in main. Proxy generation never depends on the importer or intercepts source resolution. Both callers and the registry use the original module path and export name; implementation query IDs are normalized before metadata lookup. `ipcProviderPlugin` attaches an `IpcProvider` to the main environment for discovery subscriptions, dependency recovery, definition refresh, and per-call validation. It owns no separate module runner or WebSocket server. HMR metadata refresh uses `environment.transformRequest` so preceding transforms also apply during updates, without evaluating implementations. Missing ordinary dependencies are tracked through Vite resolution and recovered when their files are created; metadata analysis does not resolve their imports. IPC implementation modules and generated preload path modules are self-accepting HMR boundaries; main IPC proxies suppress implementation-only updates and invalidate when exports change. Production main imports retain direct implementation behavior.

IPC definition identity is the source file path without query parameters plus the export name. Main and renderer transforms normalize IDs before registering definitions; Vite module IDs remain intact for loading and proxy HMR. Implementation IDs always use the source file plus `?ipc-implementation`, so custom query variants share one implementation. Production manifest collection also normalizes module IDs when selecting active definitions and retained exports. Resource query imports remain excluded from IPC compilation.

IPC implementation modules receive HMR acceptance boundaries from the plugin. Ordinary main modules require user-defined Vite `import.meta.hot.accept` boundaries for hot replacement; an update without an accepting boundary restarts Electron. Resources owned by replaced modules require user cleanup through `import.meta.hot.dispose`. Preload changes rebuild its CommonJS output and reload windows. HMR updates follow Vite semantics and do not wait for active IPC handlers. Namespace imports, reexports, and dynamic imports use Vite's normal transforms.

`ipcProtectionPlugin` validates preload source modules and rejects IPC implementation imports in both development and production. IPC compilation uses the code received by `transform`; it does not compare transformed modules against their on-disk source. `ipcEntryPlugin` validates a single entry before proxy generation and injects initialization, with separate state per environment. Main initialization uses `environment.config.command === 'serve'`; preload initialization uses `environment.config.mode === 'development'` because development preload still runs through a build. The dev server's preload watch build uses the development bridge. Development main proxies run only in the main dev environment, and encountered callers remain tracked for the session rather than being reset after a separate main build.

`examples/basic/` is a React/Electron application using the unified plugin, with renderer code in `src/` and main/preload code in `electron/`. The README files show minimal plugin configuration and all plugin options with customized Vite environments.

`dist/` contains generated bundles and declarations; do not edit it directly.

## Build, Test, and Development Commands

Use pnpm `10.33.4` and Node.js matching `^20.19.0 || >=22.12.0`, as declared in `package.json`.

- `pnpm install`: install dependencies and initialize Husky hooks.
- `pnpm dev`: rebuild the library on changes using tsdown.
- `pnpm build`: generate ESM bundles and TypeScript declarations.
- `pnpm format [paths...]`: format all supported files, or only the supplied paths, with Oxfmt.
- `pnpm typecheck`: check source, tests, and compile-time assertions without emitting files.
- `pnpm test` / `pnpm test:watch`: run the default suite once or in watch mode.
- `pnpm test:package`: build and test the distributable package.
- `ELECTRON_BINARY=/path/to/electron pnpm test:electron`: build and run real Electron integration tests.

To run an example, build the library, then run `pnpm install` and `pnpm dev` inside its directory under `examples/`. Rebuild the library and reinstall the example’s local dependency after library changes.

## Coding Style & Naming Conventions

Use strict TypeScript and explicit type-only imports.

Use camelCase for functions and variables, PascalCase for types and classes, and descriptive kebab-case module filenames. Use `#/...` for source imports that would traverse parent directories; keep `./...` imports relative. Omit file extensions in both forms. Plugin directories use `<name>-plugin` with a `plugin.ts` entry; supporting modules are named by their responsibility. IPC definitions are identified by their exports, without a required filename suffix.

Constants shared across Vite plugins belong in `src/vite/constants.ts`, including `MAIN_ENVIRONMENT`, `PRELOAD_ENVIRONMENT`, `SOURCE_MODULE_FILTER`, and `IPC_IMPLEMENTATION_ID_REGEX`. Plugin-specific shared identifiers remain in their owning plugin's `constants.ts`; `ipc-dispatcher-plugin/constants.ts` owns `IPC_DISPATCHER_MODULE`. `src/constants.ts` holds `HANDLER_KEY` and `IPC_IMPLEMENTATION_QUERY`, which are shared by runtime and Vite integration. Keep file-local constants beside their use, including `DEFAULT_BRIDGE_NAME` in `src/vite/ipc-plugin/context.ts` and the renderer path placeholder string in `load-window-plugin/plugin.ts`.

## Testing Guidelines

`tests/compiler/`, `tests/vite/`, and `tests/runtime/` follow the source boundaries. IPC context state tests live in `tests/vite/ipc-plugin/`, including registry tests in `ipc-registry.test.ts`. `tests/electron/` and `tests/package/` are separate integration suites.

Name suites `tests/<area>/*.test.ts` and describe observable behavior in test names. Reuse `tests/helpers.ts` for temporary fixtures and cleanup. IPC compilation tests use explicit Vite environments; main development tests use ModuleRunner instead of disguising a bundle build as development. Production build integration tests use the public plugin and `builder.buildApp()`. Add type assertions to `tests/types.ts` when changing inference. No coverage threshold is configured. Default tests exclude `tests/package/` and `tests/electron/`; run those separately when changing packaging or process integration.

## Commit & Pull Request Guidelines

Commitlint enforces Conventional Commits, such as `fix: handle renamed IPC channels`; the pre-commit hook runs typechecking.

Keep pull requests focused. Describe the behavior change, link relevant issues, and report validation commands and results. Update both README languages when changing documented APIs or usage.
