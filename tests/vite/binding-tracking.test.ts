import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import type { HotPayload } from 'vite'
import { expect, test, vi } from 'vitest'
import { IPC_DISPATCHER_MODULE } from '#/vite/ipc-dispatcher-plugin/constants'
import type { IpcDispatcherModule } from '#/vite/ipc-dispatcher-plugin/dispatcher-module'
import { ipcDispatcherPlugin } from '#/vite/ipc-dispatcher-plugin/plugin'
import { ipcEntryPlugin } from '#/vite/ipc-entry-plugin/plugin'
import { ipcMainPlugin } from '#/vite/ipc-main-plugin/plugin'
import { IpcContext } from '#/vite/ipc-plugin/context'
import { ipcPlugin } from '#/vite/ipc-plugin/plugin'
import { ipcProtectionPlugin } from '#/vite/ipc-protection-plugin/plugin'
import {
  bundle,
  cjs,
  electronHarness,
  entryCode,
  evaluate,
  fixture,
  outputText,
  sourceAliases,
  until,
  providerTestPlugins,
  testDispatcher,
  mainRunner,
} from '../helpers'

const schema = (multiplier = 1) => `
  import { z } from 'zod'
  export const schema = z.number().transform(value => value * ${multiplier})
`
const definitions = (channel = 'configured') => `
  import * as ipc from 'electron-trio'
  import { schema } from './schema'
  const factory = ipc['createIpcInvoke']
  const configured = factory(${JSON.stringify(channel)}).inputValidator(schema)
  export const direct = ipc.createIpcInvoke('direct').handler(() => 'MAIN_ONLY_DIRECT')
  export const renamed = factory('renamed').handler(() => 'MAIN_ONLY_RENAMED')
  export const validated = configured.handler(({ data }) => 'MAIN_ONLY_VALUE:' + data)
`
const files = {
  'schema.ts': schema(),
  'definitions.ts': definitions(),
  'renderer.ts': `export * from './definitions'`,
  'main.ts': `export * from './definitions'`,
  'preload.ts': '',
}

test('production resolves local aliases and builders and strips implementations from renderer and preload', async (t) => {
  const root = await fixture(t, files)
  const plugins = ipcPlugin({})
  const renderer = await bundle(
    root,
    plugins,
    'renderer.ts',
    cjs(root, 'renderer.ts'),
  )
  const main = await bundle(
    root,
    plugins,
    'main.ts',
    cjs(root, 'main.ts'),
    'electron_main',
  )
  const preload = await bundle(
    root,
    plugins,
    'preload.ts',
    cjs(root, 'preload.ts'),
    'electron_preload',
  )
  for (const output of [renderer, preload])
    expect(outputText(output)).not.toMatch(
      /MAIN_ONLY|zod|inputValidator|~standard/,
    )
  const harness = electronHarness()
  evaluate(entryCode(main), harness.electron)
  expect([...harness.handlers.keys()].sort()).toEqual([
    'configured',
    'direct',
    'renamed',
  ])
  evaluate(entryCode(preload), harness.electron)
  const api = evaluate(
    entryCode(renderer),
    {},
    { __ipc: harness.bridges.get('__ipc') },
  )
  expect(await api.direct()).toBe('MAIN_ONLY_DIRECT')
  expect(await api.renamed()).toBe('MAIN_ONLY_RENAMED')
  expect(await api.validated(3)).toBe('MAIN_ONLY_VALUE:3')
  await expect(api.validated('3')).rejects.toThrow()
})

test.for(['development', 'production'] as const)(
  'preload rejects a handler defined through a local builder in %s mode',
  async (mode, t) => {
    const root = await fixture(t, {
      ...files,
      'preload.ts': `import './definitions'`,
    })
    const context = new IpcContext({})
    if (mode !== 'development') context.manifest.publish([])
    await expect(
      bundle(
        root,
        [ipcProtectionPlugin(context), ipcEntryPlugin(context)],
        'preload.ts',
        {},
        'electron_preload',
        mode,
      ),
    ).rejects.toThrow('Do not import IPC implementation modules into preload')
  },
)

test('development recognizes a definition before resolving its handler dependency and recovers a missing import', async (t) => {
  const loaded = vi.fn()
  vi.stubGlobal('__definitionLoaded', loaded)
  const root = await fixture(t, {
    'definitions.ts': `
      import { createIpcInvoke } from 'electron-trio'
      import { handler } from './missing-handler'
      globalThis.__definitionLoaded()
      export const run = createIpcInvoke('run').handler(handler)
    `,
  })
  const context = new IpcContext({})
  const resolveHandler = vi.fn()
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: sourceAliases },
    plugins: [
      providerTestPlugins(context),
      {
        name: 'test:observe-handler-resolution',
        enforce: 'pre',
        resolveId(source) {
          if (source === './missing-handler') resolveHandler()
        },
      },
    ],
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true },
  })
  t.onTestFinished(() => server.close())
  expect((await server.transformRequest('/definitions.ts'))?.code).toContain(
    'createDevRendererInvoker',
  )
  expect(resolveHandler).not.toHaveBeenCalled()
  expect(loaded).not.toHaveBeenCalled()
  const dispatcher = await testDispatcher(t, server)
  const target = {
    caller: 'renderer' as const,
    moduleKey: path.join(root, 'definitions.ts'),
    exportName: 'run',
  }
  const invoke = () => dispatcher.invoke(target, undefined, undefined)
  await expect(invoke()).rejects.toThrow()
  expect(loaded).not.toHaveBeenCalled()
  await fs.writeFile(
    path.join(root, 'missing-handler.ts'),
    `export const handler = () => 'restored'`,
  )
  await until(async () => {
    try {
      return (await invoke()) === 'restored'
    } catch {
      return false
    }
  }, 'missing handler recovery')
  expect(loaded).toHaveBeenCalledOnce()
})

test.for(['main', 'renderer'] as const)(
  'development refreshes local builders for %s callers and retains ordinary dependency updates',
  async (caller, t) => {
    const root = await fixture(t, files)
    const key = path.join(root, 'definitions.ts')
    const context = new IpcContext({})
    const refreshed = new Set<string>()
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        providerTestPlugins(context),
        {
          name: 'test:observe-renderer',
          enforce: 'post',
          hotUpdate(update) {
            if (this.environment.name === 'client') refreshed.add(update.file)
          },
        },
      ],
      resolve: { alias: sourceAliases },
      server: { middlewareMode: true, ws: false },
      optimizeDeps: { noDiscovery: true },
    })
    t.onTestFinished(() => server.close())
    const messages: HotPayload[] = []
    vi.spyOn(server.environments.client.hot, 'send').mockImplementation(
      (payload) => {
        if (typeof payload !== 'string') messages.push(payload)
      },
    )
    const dispatcher = await testDispatcher(t, server)
    let invoke: (input: number) => Promise<unknown>
    if (caller === 'renderer') {
      const transformed = await server.transformRequest('/definitions.ts')
      expect(transformed?.code).toContain('createDevRendererInvoker')
      expect(JSON.stringify(transformed)).not.toMatch(
        /MAIN_ONLY|inputValidator|zod/,
      )
      invoke = (input) =>
        dispatcher.invoke(
          { caller, moduleKey: key, exportName: 'validated' },
          undefined,
          input,
        )
    } else {
      const { runner } = await mainRunner(t, root, [
        ipcDispatcherPlugin(),
        ipcMainPlugin(context),
      ])
      const dispatcherModule = await runner.import<IpcDispatcherModule>(
        IPC_DISPATCHER_MODULE,
      )
      dispatcherModule.setDispatcher(dispatcher)
      const api = await runner.import(path.join(root, 'main.ts'))
      invoke = async (input) => api.validated(input)
    }
    const lookup = () =>
      context.registry.lookup({
        caller,
        moduleKey: key,
        exportName: 'validated',
      })
    refreshed.clear()
    await Promise.all([
      fs.writeFile(key, definitions('changed')),
      fs.writeFile(path.join(root, 'schema.ts'), schema(2)),
    ])
    await until(() => refreshed.has(key), 'definition update')
    await until(
      () => lookup().channel === 'changed',
      'builder channel before first invocation',
    )
    expect(await invoke(3)).toBe('MAIN_ONLY_VALUE:6')
    expect(messages).toEqual([])

    await fs.writeFile(
      key,
      definitions('changed').replace('"changed"', 'unknownChannel'),
    )
    await until(async () => {
      try {
        await invoke(3)
        return false
      } catch {
        return true
      }
    }, 'invalid builder rejection')
    await Promise.all([
      fs.writeFile(key, definitions('restored')),
      fs.writeFile(path.join(root, 'schema.ts'), schema(3)),
    ])
    await until(async () => {
      try {
        return (await invoke(3)) === 'MAIN_ONLY_VALUE:9'
      } catch {
        return false
      }
    }, 'builder repair')
    expect(lookup().channel).toBe('restored')

    await fs.unlink(key)
    await until(async () => {
      try {
        await invoke(3)
        return false
      } catch {
        return true
      }
    }, 'deleted definition rejection')
    await Promise.all([
      fs.writeFile(key, definitions('recreated')),
      fs.writeFile(path.join(root, 'schema.ts'), schema(4)),
    ])
    await until(async () => {
      try {
        return (await invoke(3)) === 'MAIN_ONLY_VALUE:12'
      } catch {
        return false
      }
    }, 'definition recreation')
    expect(lookup().channel).toBe('recreated')
  },
)
