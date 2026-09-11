# Repository Guidelines

## Project Structure & Module Organization

`electron-ipc-invoke` is a TypeScript ESM library that generates type-safe Electron IPC wiring through Vite plugins.

- `src/index.ts`, `src/renderer.ts`, and `src/vite.ts` are the public entry points.
- `src/internal/` contains compilation, code generation, registry, session, selection, and file-watching logic.
- `tests/` contains Vitest suites, shared fixture helpers, and compile-time assertions in `types.ts`.
- `example/` is a React/Electron application, with renderer code in `src/` and main/preload code in `electron/`.
- `dist/` contains generated bundles and declarations; do not edit it directly.

## Build, Test, and Development Commands

Use pnpm `10.33.4` and Node.js matching `^20.19.0 || >=22.12.0`, as declared in `package.json`.

- `pnpm install`: install dependencies and initialize Husky hooks.
- `pnpm dev`: rebuild the library on changes using tsdown.
- `pnpm build`: generate ESM bundles and TypeScript declarations.
- `pnpm typecheck`: check source, tests, and compile-time assertions without emitting files.
- `pnpm test` / `pnpm test:watch`: run the default suite once or in watch mode.
- `pnpm test:package`: build and test the distributable package.
- `ELECTRON_BINARY=/path/to/electron pnpm test:electron`: build and run real Electron integration tests.

To run the example, build the library, then run `pnpm install` and `pnpm dev` inside `example/`. Rebuild the library and reinstall the example’s local dependency after library changes.

## Coding Style & Naming Conventions

Use strict TypeScript and explicit type-only imports. Match nearby formatting: source and tests generally use two spaces, single quotes, and no semicolons; some configuration files use tabs and double quotes. No formatter or code linter is configured.

Use camelCase for functions and variables, PascalCase for types and classes, and descriptive kebab-case module filenames. Preserve `.js` relative imports where used in library source. IPC definition files use `.ipc.ts`.

## Testing Guidelines

Name runtime suites `tests/*.test.ts` and describe observable behavior in test names. Reuse `tests/helpers.ts` for temporary fixtures and cleanup. Add type assertions to `tests/types.ts` when changing inference. No coverage threshold is configured. Default tests exclude the package and Electron suites; run those separately when changing packaging or process integration.

## Commit & Pull Request Guidelines

Commitlint enforces Conventional Commits, such as `fix: handle renamed IPC channels`; the pre-commit hook runs typechecking.

Keep pull requests focused. Describe the behavior change, link relevant issues, and report validation commands and results. Update both README languages when changing documented APIs or usage.
