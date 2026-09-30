# electron-trio

[English](README.md)

基于 Vite 简化 Electron 应用的开发与构建。

- **统一配置**：一份 Vite 配置管理 main、preload 和 renderer，支持各环境自定义，开发时自动管理 Electron 进程。
- **类型安全 IPC**：renderer 可直接导入调用一个在 main 中运行的 IPC 函数，自动推导类型、生成注册与 preload 桥接，支持 schema 输入校验和 IPC 热更新。
- **主进程热更新**：支持 Vite HMR，无接受边界的更新自动重启 Electron。
- **preload 自动构建**：导入 preload 入口即可获得构建路径，修改后自动重建并重载窗口。
- **页面加载**：`loadWindow` 自动加载开发服务器或 renderer 构建产物中的页面。

## 快速开始

### 1. 安装项目依赖

```bash
npm install electron-trio
```

### 2. 配置 Vite 插件

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { electronTrio } from 'electron-trio/vite'

export default defineConfig({
  plugins: [
    electronTrio({
      entry: 'electron/main.ts', // 主进程入口文件
    }),
  ],
})
```

### 3. 添加 preload 脚本

```ts
// electron/preload.ts
import { createPreload } from 'electron-trio'

export default createPreload(() => {
  // IPC 桥接代码会自动生成。
})
```

### 4. 创建主进程入口

```ts
// electron/main.ts
import { app, BrowserWindow } from 'electron'
import { loadWindow } from 'electron-trio'
import preload from './preload'

app.whenReady().then(() => {
  const win = new BrowserWindow({
    webPreferences: { preload }, // 直接导入 preload 脚本模块
  })
  void loadWindow(win) // 自动加载开发服务器或构建后的页面
})
```

定义一个 IPC 函数：

```ts
// electron/custom.ts
import { createIpcInvoke } from 'electron-trio'

export const ping = createIpcInvoke('ping').handler(() => 'pong')
```

### 5. 在页面中直接调用在 main 定义的 IPC 函数

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

> [`examples/basic`](./examples/basic) 中提供了一个使用 Vite、Electron、Zod schema 和 React 的最小项目。

## API

### `createIpcInvoke(channel).inputValidator(schema).handler(fn)`

定义一次异步函数，即可在 renderer 和 main 中类型安全地导入调用，参数和返回类型自动推导，并支持 handler 执行前的 schema 输入校验。跨进程调用基于 Electron 原生的 `invoke`/`handle`，注册和 preload 桥接由插件自动生成，开发时支持 IPC 实现热更新。

| 参数      | 类型                                                                     | 说明                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channel` | `string`                                                                 | 唯一且非空白的 IPC channel 字符串字面量。                                                                                                                     |
| `schema`  | [`StandardSchemaV1`](https://github.com/standard-schema/standard-schema) | 输入校验 schema，例如 Zod。不需要输入时可省略 `.inputValidator(schema)`。                                                                                     |
| `fn`      | `(context: IpcInvokeContext<Data>) => Result`                            | 处理函数。`context.event` 为 renderer 调用对应的 IPC 事件，main 调用时为 `undefined`；`context.data` 为 schema 校验后的输出，未配置输入校验时为 `undefined`。 |

**返回：** `(input: Input) => Promise<Awaited<Result>>`。可在 renderer 或 main 中调用的函数。`Input` 为 schema 输入类型；未配置输入校验时无需传参。

```ts
// electron/custom.ts
import { createIpcInvoke } from 'electron-trio'
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

  return <button onClick={sayHello}>hello</button>
}
```

> IPC 定义模块只能导出 IPC 函数和类型。
>
> preload 不能导入 IPC 定义模块，桥接由插件自动生成。
>
> 输入校验失败时，调用 Promise 会 reject，handler 不会执行；handler 抛出的错误也会使调用 reject。main 调用可通过 `IpcValidationError.issues` 获取校验详情，renderer 跨进程调用仅接收错误消息。
>
> renderer 调用时，参数和返回值须符合 [Electron IPC](https://www.electronjs.org/docs/latest/api/ipc-renderer#ipcrendererinvokechannel-args) 与 [`contextBridge`](https://www.electronjs.org/docs/latest/api/context-bridge#parameter--error--return-type-support) 的传输规则。

### `createPreload(setup)`

声明 preload 入口，main 中的默认导入为 preload 的绝对路径。

```ts
// electron/preload.ts
import { contextBridge } from 'electron'
import { createPreload } from 'electron-trio'

export default createPreload(() => {
  contextBridge.exposeInMainWorld('appInfo', { name: 'Example' })
})
```

```ts
// electron/main.ts
import { app, BrowserWindow } from 'electron'
import { loadWindow } from 'electron-trio'
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

> 必须默认导出对 `createPreload` 的直接调用，只能额外导出类型。

### `loadWindow(window)`

为 `BrowserWindow` 加载 renderer 页面：开发时加载 `VITE_DEV_SERVER_URL`，生产时加载构建产物中的 `index.html`。

| 参数     | 类型            | 说明                           |
| -------- | --------------- | ------------------------------ |
| `window` | `BrowserWindow` | 需要加载页面的 Electron 窗口。 |

**返回：** `Promise<void>`。页面加载完成时 resolve，加载失败时 reject。

```ts
// electron/main.ts
import { app, BrowserWindow } from 'electron'
import { loadWindow } from 'electron-trio'

app.whenReady().then(async () => {
  const win = new BrowserWindow()
  await loadWindow(win)
})
```

> 该函数固定加载 renderer 的单个 `index.html`，暂不支持多页面。

## Vite 插件

### `electronTrio(options)`

通过 Vite 管理 Electron 开发启动、构建和 IPC 集成。renderer、main 和 preload 的构建产物默认分别输出到 `dist/client`、`dist/main` 和 `dist/preload`。各环境可通过 Vite 的 `environments` 自定义配置。

| 名称                    | 类型       | 说明                                                    |
| ----------------------- | ---------- | ------------------------------------------------------- |
| `options.entry`         | `string`   | 必填的 main 源码入口，相对于 Vite root 或使用绝对路径。 |
| `options.bridgeName`    | `string`   | renderer 全局桥接属性名，默认 `'__ipc'`。               |
| `options.electron.args` | `string[]` | 开发时启动 Electron 的附加参数，默认 `[]`。             |

```ts
// vite.config.ts（最小配置）
import { defineConfig } from 'vite'
import { electronTrio } from 'electron-trio/vite'

export default defineConfig({
  plugins: [
    electronTrio({
      entry: 'electron/main.ts',
    }),
  ],
})
```

```ts
// vite.config.ts（全部插件选项及 environment 自定义）
import { defineConfig } from 'vite'
import { electronTrio } from 'electron-trio/vite'

export default defineConfig({
  plugins: [
    electronTrio({
      entry: 'electron/main.ts',
      bridgeName: 'desktop',
      electron: { args: ['--enable-logging'] },
    }),
  ],
  environments: {
    client: {
      // renderer 的 Vite 配置
    },
    electron_main: {
      // main 的 Vite 配置
    },
    electron_preload: {
      // preload 的 Vite 配置
    },
  },
})
```

> 不支持生产 `vite build --watch`。

## 版本要求

- Node.js：`^20.19.0 || >=22.12.0`
- Vite：`^8.2.0`
- Electron：`>=44.0.0`
