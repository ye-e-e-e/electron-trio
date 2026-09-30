import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import vm from 'node:vm'
import {
  createBuilder,
  createServer,
  createServerModuleRunnerTransport,
} from 'vite'
import type {
  BuildOptions,
  DevEnvironment,
  PluginOption,
  Rolldown,
  ViteDevServer,
} from 'vite'
import { ModuleRunner, createNodeImportMeta } from 'vite/module-runner'
import type { TestContext } from 'vitest'
import { createIpcDispatcher } from '#/runtime/ipc-dispatcher'
import { VALIDATE_REQUEST, VALIDATE_RESPONSE } from '#/runtime/protocol'
import type { IpcContext } from '#/vite/ipc-plugin/context'
import { ipcPlugin } from '#/vite/ipc-plugin/plugin'
import type { IpcContextOptions } from '#/vite/ipc-plugin/types'
import { ipcProviderPlugin } from '#/vite/ipc-provider-plugin/plugin'
import { ipcRendererPlugin } from '#/vite/ipc-renderer-plugin/plugin'

// Exercise the IPC layer with Vite's real environments, without spawning Electron.
export function ipcPlugins(options: IpcContextOptions = {}) {
  return ipcPlugin(options)
}

export function providerTestPlugins(context: IpcContext): PluginOption[] {
  return [
    ipcRendererPlugin(context),
    ipcProviderPlugin(context),
    {
      name: 'test:main-environment',
      config() {
        return {
          environments: {
            electron_main: {
              consumer: 'server',
              keepProcessEnv: true,
              optimizeDeps: { noDiscovery: true },
              dev: { moduleRunnerTransform: true },
            },
          },
        }
      },
    },
  ]
}

// Exercise the provider's actual validation protocol with a runner in this process.
export async function testDispatcher(t: TestContext, server: ViteDevServer) {
  const transport = createServerModuleRunnerTransport({
    channel: server.environments.electron_main.hot,
  })
  let sequence = 0
  const requests = new Map<
    number,
    { resolve(): void; reject(error: Error): void }
  >()
  const runner = new ModuleRunner({
    createImportMeta: createNodeImportMeta,
    hmr: { logger: false },
    transport: {
      ...transport,
      connect(handlers) {
        return transport.connect!({
          ...handlers,
          onMessage(payload) {
            if (
              payload.type !== 'custom' ||
              payload.event !== VALIDATE_RESPONSE
            )
              return handlers.onMessage(payload)
            const request = requests.get(payload.data.id)
            requests.delete(payload.data.id)
            if (payload.data.error)
              request?.reject(new Error(payload.data.error))
            else request?.resolve()
          },
        })
      },
    },
  })
  const dispatcher = createIpcDispatcher({
    runner,
    validate: (target) =>
      new Promise<void>((resolve, reject) => {
        const id = ++sequence
        requests.set(id, { resolve, reject })
        transport.send!({
          type: 'custom',
          event: VALIDATE_REQUEST,
          data: { id, target },
        })
      }),
  })
  // Connect before validation, which precedes the first runner.import.
  await runner.import('data:text/javascript,export default 0')
  t.onTestFinished(() => runner.close())
  return dispatcher
}

export type BuildOutput = Array<Rolldown.OutputChunk | Rolldown.OutputAsset>
export type TestEvent = { sender?: { id: number } }
type Handler<Result> = (
  event: TestEvent,
  input: unknown,
) => Result | Promise<Result>
type Bridge = Record<string, (input: unknown) => unknown>

// Nested Vite projects resolve fixture imports to source without a library build.
export const sourceAliases = [
  {
    find: /^electron-start$/,
    replacement: path.resolve(import.meta.dirname, '../src/index.ts'),
  },
]

// Fixtures rewrite sources immediately after watch builds finish. Polling keeps
// these synthetic updates observable when native file events are coalesced.
export const fixtureWatch = {
  buildDelay: 10,
  chokidar: { usePolling: true, interval: 25 },
}

export async function fixture(
  t: TestContext,
  files: Record<string, string> = {},
) {
  const root = await fs.mkdtemp(
    path.join(path.resolve(import.meta.dirname, '..'), '.ipc-test-'),
  )
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }))
  await writeFiles(root, files)
  return root
}

export async function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, code] of Object.entries(files)) {
    const file = path.join(root, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, code)
  }
}

export const ipcSource = (body: string) =>
  `import { z } from 'zod'; import { createIpcInvoke } from 'electron-start';\n${body}`
export const definition = (channel: string) =>
  `import { createIpcInvoke } from 'electron-start'; export const run = createIpcInvoke(${JSON.stringify(channel)}).handler(() => 1)`

export async function bundle(
  root: string,
  plugins: PluginOption,
  entry: string,
  extra: BuildOptions = {},
  environment = 'client',
  mode?: string,
): Promise<BuildOutput> {
  const builder = await createBuilder({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [plugins],
    mode,
    resolve: { alias: sourceAliases },
    builder: { sharedConfigBuild: true },
    environments: {
      [environment]: {
        consumer: environment === 'client' ? 'client' : 'server',
        resolve: { noExternal: true },
        build: {
          write: false,
          minify: false,
          sourcemap: true,
          lib: { entry: path.join(root, entry), formats: ['es'] },
          rolldownOptions: { external: ['electron'] },
          ...extra,
        },
      },
    },
  })
  const result = await builder.build(builder.environments[environment])
  if (!Array.isArray(result) && !('output' in result))
    throw new Error('Expected a completed build, not a watcher')
  return (Array.isArray(result) ? result : [result]).flatMap(
    (part) => part.output,
  )
}

export async function mainRunner(
  t: TestContext,
  root: string,
  plugins: PluginOption,
) {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [plugins],
    cacheDir: path.join(root, '.vite'),
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: sourceAliases },
    server: { middlewareMode: true, ws: false },
    environments: {
      electron_main: {
        consumer: 'server',
        keepProcessEnv: true,
        resolve: { noExternal: true },
        optimizeDeps: { noDiscovery: true },
        dev: { moduleRunnerTransform: true },
        build: { rolldownOptions: { input: path.join(root, 'main.ts') } },
      },
    },
  })
  t.onTestFinished(() => server.close())
  const environment = server.environments.electron_main
  const runner = new ModuleRunner({
    createImportMeta: createNodeImportMeta,
    hmr: { logger: false },
    transport: createServerModuleRunnerTransport({ channel: environment.hot }),
  })
  t.onTestFinished(() => runner.close())
  return { server, runner }
}

// Drive the native Electron environment's module loading without spawning Electron.
export function fetchRunner(t: TestContext, environment: DevEnvironment) {
  const runner = new ModuleRunner({
    createImportMeta: createNodeImportMeta,
    hmr: false,
    transport: {
      async invoke(payload) {
        if (payload.type !== 'custom' || payload.event !== 'vite:invoke')
          throw new Error('Unexpected runner payload')
        const { name, data } = payload.data
        if (name === 'getBuiltins')
          return {
            result: environment.config.resolve.builtins.map((value) =>
              typeof value === 'string'
                ? value
                : { type: 'regexp', source: value.source, flags: value.flags },
            ),
          }
        if (name !== 'fetchModule')
          throw new Error(`Unexpected runner request: ${name}`)
        return {
          result: await Reflect.apply(
            environment.fetchModule,
            environment,
            data,
          ),
        }
      },
    },
  })
  t.onTestFinished(() => runner.close())
  return runner
}

export function evaluate<
  Exports = Record<string, (input?: unknown) => unknown>,
>(
  code: string,
  electron: object = {},
  globals: Record<string, unknown> = {},
  modules: Record<string, unknown> = {},
): Exports {
  const context = {
    exports: {},
    ...globals,
    require(id: string) {
      if (id === 'electron') return electron
      assert.ok(
        Object.hasOwn(modules, id),
        `Unexpected runtime dependency: ${id}`,
      )
      return modules[id]
    },
  }
  vm.runInNewContext(code, context)
  return context.exports as Exports
}

export function channels(code: string) {
  const found: string[] = []
  evaluate(
    code,
    {
      ipcMain: {
        handle(channel: string) {
          found.push(channel)
        },
        removeHandler() {},
      },
      contextBridge: {
        exposeInMainWorld(_name: string, bridge: Bridge) {
          found.push(...Object.keys(bridge))
        },
      },
      ipcRenderer: {},
    },
    { __dirname: '/test' },
    { 'node:path': path },
  )
  return found.sort()
}

export async function until(
  predicate: () => unknown | Promise<unknown>,
  label: string,
) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

export function electronHarness<Result = unknown>() {
  const handlers = new Map<string, Handler<Result>>()
  const bridges = new Map<string, Bridge>()
  const electron = {
    app: { getVersion: () => 'test-app-version' },
    ipcMain: {
      handle(channel: string, handler: Handler<Result>) {
        if (handlers.has(channel))
          throw new Error(`Existing handler: ${channel}`)
        handlers.set(channel, handler)
      },
      removeHandler(channel: string) {
        handlers.delete(channel)
      },
    },
    contextBridge: {
      exposeInMainWorld(name: string, bridge: Bridge) {
        bridges.set(name, bridge)
      },
    },
    ipcRenderer: {
      invoke(channel: string, input: unknown) {
        const handler = handlers.get(channel)
        assert.ok(handler, `Missing IPC handler: ${channel}`)
        return handler({ sender: { id: 1 } }, input)
      },
    },
  }
  return { electron, handlers, bridges }
}

export function entryCode(output: BuildOutput): string {
  const entry = output.find((item) => item.type === 'chunk' && item.isEntry)
  assert.ok(entry?.type === 'chunk', 'Expected an entry chunk')
  return entry.code
}
export const outputText = (output: BuildOutput) =>
  output
    .map((item) => (item.type === 'chunk' ? item.code : item.source))
    .join('\n')
export const cjs = (root: string, entry: string): BuildOptions => ({
  lib: { entry: path.join(root, entry), formats: ['cjs'] },
})
