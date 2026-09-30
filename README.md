# electron-start

[简体中文](README.zh-CN.md)

Simplify Electron application development and builds with Vite.

- **Unified configuration**: One Vite configuration for main, preload, and renderer, with per-environment options and automatic Electron process management during development.
- **Type-safe IPC**: Renderer code can directly import and call an IPC function that runs in main, with inferred types, optional schema validation, generated registration and preload bridges, and IPC HMR.
- **Main process HMR**: Vite HMR support, with Electron restarting when an update has no accepting boundary.
- **Automatic preload builds**: Import preload entries as built script paths; changes rebuild scripts and reload windows.
- **Renderer loading**: `loadWindow` automatically loads the development server or built renderer page.

## Quick Start

### 1. Install project dependencies

```bash
npm install electron-start
```

### 2. Configure the Vite plugin

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { electronStart } from 'electron-start/vite'

export default defineConfig({
  plugins: [
    electronStart({
      entry: 'electron/main.ts', // Main process entry file
    }),
  ],
})
```

### 3. Add a preload script

```ts
// electron/preload.ts
import { createPreload } from 'electron-start'

export default createPreload(() => {
  // The IPC bridge is generated automatically.
})
```

### 4. Create the main process entry

```ts
// electron/main.ts
import { app, BrowserWindow } from 'electron'
import { loadWindow } from 'electron-start'
import preload from './preload'

app.whenReady().then(() => {
  const win = new BrowserWindow({
    webPreferences: { preload }, // Import the preload script module directly
  })
  void loadWindow(win) // Automatically load the development server or built page
})
```

```ts
// electron/custom.ts
import { createIpcInvoke } from 'electron-start'

export const ping = createIpcInvoke('ping').handler(() => 'pong')
```

### 5. Directly call an IPC function defined in main from the renderer

```tsx
// src/App.tsx
import { ping } from '../electron/custom'

export default function App() {
  async function onPing() {
    console.log(await ping()) // "pong"
  }

  return <button onClick={onPing}>Ping</button>
}
```

> [`examples/basic`](./examples/basic) provides a minimal project using Vite, Electron, Zod schemas, and React.

## API

### `createIpcInvoke(channel).inputValidator(schema).handler(fn)`

Define an async function once and import it from renderer or main, with inferred parameter and return types and optional schema validation before the handler runs. Cross-process calls use Electron's native `invoke`/`handle` APIs. The plugins generate IPC registration and preload bridges and support HMR for IPC implementations during development.

| Parameter | Type                                                                     | Description                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channel` | `string`                                                                 | Unique, non-blank IPC channel string literal.                                                                                                                                |
| `schema`  | [`StandardSchemaV1`](https://github.com/standard-schema/standard-schema) | Input schema, such as Zod. Omit `.inputValidator(schema)` when no input is needed.                                                                                           |
| `fn`      | `(context: IpcInvokeContext<Data>) => Result`                            | Handler. `context.event` is the renderer IPC event, or `undefined` for main calls. `context.data` is the validated schema output, or `undefined` without an input validator. |

**Returns:** `(input: Input) => Promise<Awaited<Result>>`. A function callable from renderer or main. `Input` is the schema input type; no argument is required without an input validator.

```ts
// electron/custom.ts
import { createIpcInvoke } from 'electron-start'
import { z } from 'zod'

export const greet = createIpcInvoke('greet')
  .inputValidator(z.object({ name: z.string() }))
  .handler(({ data }) => `Hello, ${data.name}!`)

export const ping = createIpcInvoke('ping').handler(() => 'pong')
```

```tsx
// src/App.tsx
import { greet } from '../electron/custom'

export default function App() {
  async function sayHello() {
    // greet: (input: { name: string }) => Promise<string>
    const message = await greet({ name: 'Electron' })
    console.log(message) // "Hello, Electron!"
  }

  return <button onClick={sayHello}>Say hello</button>
}
```

> IPC definition modules may export only IPC functions and types.
>
> Preload scripts cannot import IPC definition modules; the bridge is generated automatically.
>
> Input validation failures reject the call's Promise without running the handler. Errors thrown by the handler also reject the call. Main callers can access validation details through `IpcValidationError.issues`; renderer calls across processes receive only the error message.
>
> Renderer arguments and return values must follow the transport rules of [Electron IPC](https://www.electronjs.org/docs/latest/api/ipc-renderer#ipcrendererinvokechannel-args) and [`contextBridge`](https://www.electronjs.org/docs/latest/api/context-bridge#parameter--error--return-type-support).

### `createPreload(setup)`

Declare a preload entry whose default import in main is the preload's absolute path.

```ts
// electron/preload.ts
import { contextBridge } from 'electron'
import { createPreload } from 'electron-start'

export default createPreload(() => {
  contextBridge.exposeInMainWorld('appInfo', { name: 'Example' })
})
```

```ts
// electron/main.ts
import { app, BrowserWindow } from 'electron'
import { loadWindow } from 'electron-start'
import preload from './preload'

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  await loadWindow(win)
})
```

> Default-export a direct `createPreload` call. Additional exports must be types.

### `loadWindow(window)`

Load the renderer into a `BrowserWindow`: use `VITE_DEV_SERVER_URL` during development, or the built renderer's `index.html` in production.

| Parameter | Type            | Description                                  |
| --------- | --------------- | -------------------------------------------- |
| `window`  | `BrowserWindow` | Electron window whose page should be loaded. |

**Returns:** `Promise<void>`. Resolves when the page finishes loading; rejects if loading fails.

```ts
// electron/main.ts
import { app, BrowserWindow } from 'electron'
import { loadWindow } from 'electron-start'

app.whenReady().then(async () => {
  const win = new BrowserWindow()
  await loadWindow(win)
})
```

> This helper loads a single renderer `index.html`; multi-page applications are not yet supported.

## Vite Plugin

### `electronStart(options)`

Manage Electron development startup, builds, and IPC integration through Vite. The default output directories are `dist/client` for renderer, `dist/main` for main, and `dist/preload` for preload. Customize each environment through Vite's `environments` configuration.

| Name                    | Type       | Description                                                             |
| ----------------------- | ---------- | ----------------------------------------------------------------------- |
| `options.entry`         | `string`   | Required main source entry, relative to Vite root or absolute.          |
| `options.bridgeName`    | `string`   | Renderer global bridge property. Defaults to `'__ipc'`.                 |
| `options.electron.args` | `string[]` | Additional Electron startup arguments in development. Defaults to `[]`. |

```ts
// vite.config.ts (minimal configuration)
import { defineConfig } from 'vite'
import { electronStart } from 'electron-start/vite'

export default defineConfig({
  plugins: [
    electronStart({
      entry: 'electron/main.ts',
    }),
  ],
})
```

```ts
// vite.config.ts (all plugin options and environment customization)
import { defineConfig } from 'vite'
import { electronStart } from 'electron-start/vite'

export default defineConfig({
  plugins: [
    electronStart({
      entry: 'electron/main.ts',
      bridgeName: 'desktop',
      electron: { args: ['--enable-logging'] },
    }),
  ],
  environments: {
    client: {
      // Renderer Vite options
    },
    electron_main: {
      // Main Vite options
    },
    electron_preload: {
      // Preload Vite options
    },
  },
})
```

> Production `vite build --watch` is not supported.

## Version Requirements

- Node.js: `^20.19.0 || >=22.12.0`
- Vite: `^8.2.0`
- Electron: `>=44.0.0`
