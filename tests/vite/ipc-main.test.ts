import fs from 'node:fs/promises'
import path from 'node:path'
import type { HotPayload } from 'vite'
import { expect, test, vi } from 'vitest'
import type { TestContext } from 'vitest'
import { createIpcDispatcher } from '#/runtime/ipc-dispatcher'
import type { IpcDispatcher } from '#/runtime/ipc-dispatcher'
import { IPC_DISPATCHER_MODULE } from '#/vite/ipc-dispatcher-plugin/constants'
import type { IpcDispatcherModule } from '#/vite/ipc-dispatcher-plugin/dispatcher-module'
import { ipcDispatcherPlugin } from '#/vite/ipc-dispatcher-plugin/plugin'
import { ipcMainPlugin } from '#/vite/ipc-main-plugin/plugin'
import { IpcContext } from '#/vite/ipc-plugin/context'
import { ipcProviderPlugin } from '#/vite/ipc-provider-plugin/plugin'
import { ipcRendererPlugin } from '#/vite/ipc-renderer-plugin/plugin'
import { fixture, mainRunner, until } from '../helpers'

async function loadMain(
  t: TestContext,
  entry: string,
  files: Record<string, string> = {},
) {
  const root = await fixture(t, {
    'definitions.ts':
      "import { createIpcInvoke } from 'electron-start'; export const old = createIpcInvoke('old').handler(() => 'not bundled')",
    'ordinary.ts': 'export const ordinary = 42',
    'barrel.ts': 'export * from "./definitions"; export * from "./ordinary"',
    'main.ts': entry,
    ...files,
  })
  const context = new IpcContext({})
  let current: Record<string, (input?: unknown) => unknown> = {
    old: () => 'v1',
  }
  const dispatcher: IpcDispatcher = {
    invoke: async (target, _event, input) => {
      if (target.caller !== 'main') throw new Error('main only')
      const fn = current[target.exportName]
      if (!fn) throw new Error(`Missing export ${target.exportName}`)
      return fn(input)
    },
  }
  const ordinaryLoaded = vi.fn()
  vi.stubGlobal('__ordinaryLoaded', ordinaryLoaded)
  const { server, runner } = await mainRunner(t, root, [
    ipcDispatcherPlugin(),
    ipcMainPlugin(context),
  ])
  const dispatcherModule = await runner.import<IpcDispatcherModule>(
    IPC_DISPATCHER_MODULE,
  )
  dispatcherModule.setDispatcher(dispatcher)
  const exports = await runner.import<Record<string, (...args: any[]) => any>>(
    path.join(root, 'main.ts'),
  )
  const code = [
    ...server.environments.electron_main.moduleGraph.idToModuleMap.values(),
  ]
    .map((node) => node.transformResult?.code ?? '')
    .join('\n')
  return {
    exports,
    update(value: typeof current) {
      current = value
    },
    ordinaryLoaded,
    code,
  }
}

test('main namespace exports stay fixed while existing function proxies use the latest implementation', async (t) => {
  const app = await loadMain(
    t,
    'import * as ns from "./definitions"; export const get = () => ns',
  )
  const ns = app.exports.get()
  const old = ns.old
  expect(await old()).toBe('v1')
  app.update({ old: () => 'v2', added: () => 2 })
  expect(ns.old).toBe(old)
  expect(await old()).toBe('v2')
  expect(Object.keys(ns)).toEqual(['old'])
  expect(ns.added).toBeUndefined()
  app.update({ added: () => 3 })
  expect(Object.keys(ns)).toEqual(['old'])
  await expect(old()).rejects.toThrow('Missing export old')
  expect(app.code).not.toContain('not bundled')
})

test('IPC exports can use dispatcher helper names without shadowing the generated import', async (t) => {
  const names = ['getDispatcher', '__getDispatcher', '__getDispatcher_']
  const app = await loadMain(t, 'export * from "./definitions"', {
    'definitions.ts':
      `import { createIpcInvoke } from 'electron-start';\n` +
      names
        .map(
          (name) =>
            `export const ${name} = createIpcInvoke(${JSON.stringify(name)}).handler(() => 'not bundled')`,
        )
        .join('\n'),
  })
  app.update(
    Object.fromEntries(
      names.map((name) => [name, (input: unknown) => [name, input]]),
    ),
  )
  for (const name of names)
    expect(await app.exports[name](42)).toEqual([name, 42])
})

test('named imports through a barrel retain function proxies', async (t) => {
  const app = await loadMain(
    t,
    'import { old } from "./barrel"; export const get = () => old',
  )
  const old = app.exports.get()
  expect(await old()).toBe('v1')
  app.update({ old: () => 'v2' })
  expect(await old()).toBe('v2')
  expect(app.exports.get()).toBe(old)
})

test('dynamic barrel imports keep ordinary dependency initialization lazy', async (t) => {
  const app = await loadMain(t, 'export const get = () => import("./barrel")', {
    'ordinary.ts': 'globalThis.__ordinaryLoaded(); export const ordinary = 42',
  })
  expect(app.ordinaryLoaded).not.toHaveBeenCalled()
  const ns = await app.exports.get()
  expect(app.ordinaryLoaded).toHaveBeenCalledTimes(1)
  expect(ns.ordinary).toBe(42)
  expect(await ns.old()).toBe('v1')
  app.update({ old: () => 'v2' })
  expect(await ns.old()).toBe('v2')
})

test.for(['', '?variant=desktop'])(
  'transformed definitions use stable calling proxies and one lazy implementation: %s',
  async (query, t) => {
    const root = await fixture(t, {
      'state.ts': 'export const state = { loads: 0, count: 0 }',
      'definitions.ts': `import { state } from './state'; state.loads++; export const run = GENERATED_DEFINITION`,
      'main.ts': `import * as functions from './definitions${query}'; export { state } from './state'; export const get = () => functions; export const load = () => import('./definitions${query}')`,
    })
    const context = new IpcContext({})
    const { server, runner } = await mainRunner(t, root, [
      {
        name: 'test:generated-definition',
        enforce: 'pre',
        // Avoid delayed native events from fixture creation being treated as edits.
        config() {
          return { server: { watch: { usePolling: true, interval: 25 } } }
        },
        transform(code, id) {
          if (id.split('?')[0] === path.join(root, 'definitions.ts')) {
            return (
              `import { createIpcInvoke } from 'electron-start'; import { z } from 'zod';\n` +
              code.replace(
                'GENERATED_DEFINITION',
                `createIpcInvoke('run').inputValidator(z.number()).handler(({ data, event }) => ({ count: state.count += data, sender: event?.sender.id }))`,
              )
            )
          }
        },
      },
      ipcDispatcherPlugin(),
      ipcRendererPlugin(context),
      ipcMainPlugin(context),
      ipcProviderPlugin(context),
    ])
    const mainMessages: HotPayload[] = []
    const rendererMessages: HotPayload[] = []
    for (const [environment, messages] of [
      [server.environments.electron_main, mainMessages],
      [server.environments.client, rendererMessages],
    ] as const) {
      const send = environment.hot.send.bind(environment.hot)
      vi.spyOn(environment.hot, 'send').mockImplementation(
        (payload: HotPayload | string, data?: unknown) => {
          if (typeof payload === 'string') return send(payload, data)
          if (payload.type !== 'custom') messages.push(payload)
          send(payload)
        },
      )
    }
    const dispatcher = createIpcDispatcher({
      runner,
      validate: async (target) => {
        context.registry.lookup(target)
      },
    })
    const dispatcherModule = await runner.import<IpcDispatcherModule>(
      IPC_DISPATCHER_MODULE,
    )
    dispatcherModule.setDispatcher(dispatcher)
    type Functions = {
      run(input: number): Promise<{ count: number; sender?: number }>
    }
    const app = await runner.import<{
      state: { loads: number; count: number }
      get(): Functions
      load(): Promise<Functions>
    }>(path.join(root, 'main.ts'))
    const key = path.join(root, 'definitions.ts')
    const direct = await runner.import<Functions>(key + query)
    expect(direct.run).toBe(app.get().run)
    expect((await app.load()).run).toBe(direct.run)
    expect(app.state.loads).toBe(0)
    expect(await direct.run(2)).toEqual({ count: 2, sender: undefined })
    expect(app.state).toEqual({ loads: 1, count: 2 })
    const other = await runner.import<Functions>(
      key + (query ? '' : '?variant=desktop'),
    )
    expect(await other.run(0)).toEqual({ count: 2, sender: undefined })
    expect(app.state.loads).toBe(1)

    await server.transformRequest('/definitions.ts' + query)
    await server.transformRequest(
      '/definitions.ts' + (query ? '' : '?variant=desktop'),
    )
    const event = { sender: { id: 7 } } as Electron.IpcMainInvokeEvent
    expect(
      await dispatcher.invoke(
        { caller: 'renderer', moduleKey: key, exportName: 'run' },
        event,
        3,
      ),
    ).toEqual({ count: 5, sender: 7 })
    expect(app.state).toEqual({ loads: 1, count: 5 })
    mainMessages.length = 0
    rendererMessages.length = 0

    // Discovery and refresh must both use the preceding plugin's generated code.
    await fs.writeFile(
      path.join(root, 'definitions.ts'),
      `import { state } from './state'; state.loads += 10; export const run = GENERATED_DEFINITION`,
    )
    await until(
      () => mainMessages.length > 0,
      'main implementation HMR notification',
    )
    await until(async () => {
      try {
        await direct.run(0)
        return app.state.loads === 11
      } catch {
        return false
      }
    }, 'HMR of a generated IPC definition')
    expect(app.get().run).toBe(direct.run)
    expect(await other.run(0)).toEqual({ count: 5, sender: undefined })
    expect(await direct.run(1)).toEqual({ count: 6, sender: undefined })
    expect(
      await dispatcher.invoke(
        { caller: 'renderer', moduleKey: key, exportName: 'run' },
        event,
        1,
      ),
    ).toEqual({ count: 7, sender: 7 })
    const implementationUrl =
      server.environments.electron_main.moduleGraph.getModuleById(
        `${key}?ipc-implementation`,
      )!.url
    expect(mainMessages).toEqual([
      expect.objectContaining({
        type: 'update',
        updates: [
          expect.objectContaining({
            path: implementationUrl,
            acceptedPath: implementationUrl,
          }),
        ],
      }),
    ])
    expect(rendererMessages).toEqual([])
  },
)
