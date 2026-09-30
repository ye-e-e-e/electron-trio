import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { expect, test, vi } from 'vitest'
import { IpcContext } from '#/vite/ipc-plugin/context'
import {
  definition as ipcDefinition,
  fixture,
  fixtureWatch,
  sourceAliases,
  until,
  providerTestPlugins,
  testDispatcher,
} from '../helpers'

const source = (
  value: number,
) => `import { createIpcInvoke } from 'electron-trio';
import { suffix } from '@main-helper';
import { identity } from './identity';
import { existsSync } from 'node:fs';
import { basename } from 'path';
if (!existsSync(import.meta.filename) || basename(import.meta.filename) !== 'functions.ts') throw new Error('Node builtins unavailable');
if (basename(identity) !== 'identity.ts') throw new Error('Application preserveSymlinks was not retained');
let count = 0;
export const run = createIpcInvoke('run').handler(() => ({ value: ${value}, count: ++count, suffix, defined: __IPC_TEST__ }))`

test('IPC provider uses application plugins and the application server owns its lifecycle', async (t) => {
  const definition =
    "import { value } from 'virtual:application-value'; import { createIpcInvoke } from 'electron-trio'; export const run = createIpcInvoke('run').handler(() => value)"
  const root = await fixture(t, { 'definition.ts': definition })
  const key = path.join(root, 'definition.ts')
  const context = new IpcContext({})
  await context.registry.register(definition, key, 'main')
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: sourceAliases },
    plugins: [
      providerTestPlugins(context),
      {
        name: 'application-value',
        resolveId(id) {
          if (id === 'virtual:application-value') return '\0' + id
        },
        load(id) {
          if (id === '\0virtual:application-value')
            return 'export const value = APPLICATION_VALUE'
        },
        transform(code, id) {
          if (id === '\0virtual:application-value')
            return code.replace('APPLICATION_VALUE', '42')
        },
      },
    ],
    server: { middlewareMode: true, ws: false },
  })
  t.onTestFinished(() => server.close())
  const dispatcher = await testDispatcher(t, server)
  expect(server.environments.electron_main).toBeDefined()
  expect(server.environments.electron_main.moduleGraph).not.toBe(
    server.environments.client.moduleGraph,
  )
  const close = vi.spyOn(server.environments.electron_main, 'close')
  expect((await server.transformRequest('/definition.ts'))?.code).toContain(
    'createDevRendererInvoker',
  )
  expect(
    await dispatcher.invoke(
      { caller: 'main', moduleKey: key, exportName: 'run' },
      undefined,
      undefined,
    ),
  ).toBe(42)

  const previousWatch = vi.spyOn(server.watcher, 'add')
  await server.restart()
  expect(close).toHaveBeenCalledTimes(1)
  previousWatch.mockClear()
  const currentWatch = vi.spyOn(server.watcher, 'add')
  const discovered = path.join(root, 'discovered.ts')
  await context.registry.register(
    ipcDefinition('discovered'),
    discovered,
    'main',
  )
  expect(previousWatch).not.toHaveBeenCalled()
  expect(currentWatch).toHaveBeenCalledWith(discovered)
  const nextDispatcher = await testDispatcher(t, server)
  expect(
    await nextDispatcher.invoke(
      { caller: 'main', moduleKey: key, exportName: 'run' },
      undefined,
      undefined,
    ),
  ).toBe(42)
  const closeRestarted = vi.spyOn(server.environments.electron_main, 'close')
  await server.close()
  expect(closeRestarted).toHaveBeenCalledTimes(1)
  currentWatch.mockClear()
  await context.registry.register(
    ipcDefinition('after-close'),
    path.join(root, 'after-close.ts'),
    'main',
  )
  expect(currentWatch).not.toHaveBeenCalled()
})

test(
  'implementation environment uses application HMR and preserves encountered callers',
  { timeout: 30000 },
  async (t) => {
    const root = await fixture(t, {
      'package.json': '{"type":"module"}',
      'index.html': '',
      'functions.ts': source(1),
      'helper.ts': 'export const suffix = "first"',
      'real-identity.ts': 'export const identity = import.meta.filename',
      'unrelated.ts':
        "import { createIpcInvoke } from 'electron-trio'; export const unrelated = createIpcInvoke('other').handler(() => 'ok')",
      'undiscovered.ts': 'invalid source @@@',
    })
    await fs.symlink(
      path.join(root, 'real-identity.ts'),
      path.join(root, 'identity.ts'),
    )
    const key = path.join(root, 'functions.ts')
    const other = path.join(root, 'unrelated.ts')
    const context = new IpcContext({})
    const registry = context.registry
    await registry.register(source(1), key, 'main')
    await registry.register(source(1), key, 'renderer')
    await registry.register(await fs.readFile(other, 'utf8'), other, 'main')
    const server = await createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      appType: 'custom',
      plugins: [providerTestPlugins(context)],
      resolve: {
        alias: [
          ...sourceAliases,
          { find: '@main-helper', replacement: path.join(root, 'helper.ts') },
        ],
        preserveSymlinks: true,
      },
      define: { __IPC_TEST__: '"application"' },
      server: {
        middlewareMode: true,
        ws: false,
        // Keep successive fixture edits outside Chokidar's 50ms change throttle.
        watch: { ...fixtureWatch.chokidar, interval: 100 },
      },
      environments: {
        electron_main: {
          define: { __IPC_TEST__: '"defined"' },
          resolve: { conditions: ['custom-runner'] },
        },
      },
    })
    t.onTestFinished(() => server.close())
    const dispatcher = await testDispatcher(t, server)
    const local = () =>
      dispatcher.invoke(
        { caller: 'main', moduleKey: key, exportName: 'run' },
        undefined,
        undefined,
      )
    const remote = () =>
      dispatcher.invoke(
        { caller: 'renderer', moduleKey: key, exportName: 'run' },
        undefined,
        undefined,
      )
    const currentValue = async () => {
      try {
        return ((await remote()) as { value: number }).value
      } catch {
        return undefined
      }
    }
    expect(await local()).toEqual({
      value: 1,
      count: 1,
      suffix: 'first',
      defined: 'defined',
    })
    expect(await remote()).toMatchObject({ count: 2 })
    await fs.writeFile(key, source(2))
    await until(
      async () => (await currentValue()) === 2,
      'function body update',
    )
    expect(await remote()).toMatchObject({ value: 2 })
    await fs.writeFile(
      path.join(root, 'helper.ts'),
      'export const suffix = "second"',
    )
    await until(async () => {
      try {
        return ((await local()) as { suffix: string }).suffix === 'second'
      } catch {
        return false
      }
    }, 'dependency update')
    expect(await local()).toMatchObject({ suffix: 'second' })
    await fs.writeFile(key, source(3) + '\ninvalid @@@')
    await until(async () => {
      try {
        await local()
        return false
      } catch {
        return true
      }
    }, 'syntax failure')
    expect(
      await dispatcher.invoke(
        { caller: 'main', moduleKey: other, exportName: 'unrelated' },
        undefined,
        undefined,
      ),
    ).toBe('ok')
    await fs.writeFile(key, source(4))
    await until(async () => (await currentValue()) === 4, 'syntax repair')
    expect(await remote()).toMatchObject({ value: 4 })
    expect([...registry.callers(key)].sort()).toEqual(['main', 'renderer'])
    expect([...registry.callers(other)]).toEqual(['main'])
    await expect(
      dispatcher.invoke(
        { caller: 'renderer', moduleKey: other, exportName: 'unrelated' },
        undefined,
        undefined,
      ),
    ).rejects.toThrow('Unknown IPC export')
    await fs.unlink(key)
    await until(() => registry.read(key) === undefined, 'definition deletion')
    expect(registry.read(key)).toBeUndefined()
    await expect(local()).rejects.toThrow()
    await fs.writeFile(key, 'export const run = () => 5')
    await until(
      () => registry.read(key)?.kind === 'ordinary',
      'ordinary file recreation',
    )
    await expect(local()).rejects.toThrow('Unknown IPC export')
    await expect(remote()).rejects.toThrow('Unknown IPC export')
    await fs.writeFile(key, source(5))
    await until(
      async () => (await currentValue()) === 5,
      'definition restoration',
    )
    expect(await remote()).toMatchObject({ value: 5 })
    await fs.writeFile(key, source(6))
    await fs.writeFile(key, source(7))
    await until(async () => (await currentValue()) === 7, 'rapid update')
    await fs.unlink(key)
    await until(
      () => registry.read(key) === undefined,
      'removed definition failure',
    )
    await fs.writeFile(key, source(8))
    await until(
      async () => (await currentValue()) === 8,
      'encountered caller restoration',
    )
    expect(await remote()).toMatchObject({ value: 8 })
    expect(await local()).toMatchObject({ value: 8 })
    expect([...registry.callers(key)].sort()).toEqual(['main', 'renderer'])
  },
)

test('module requests validate renderer targets before evaluation, including cache hits', async (t) => {
  const create = (effect: string) =>
    `import { createIpcInvoke } from 'electron-trio'; ${effect}; export const run = createIpcInvoke('private').handler(() => 42)`
  const source = create('globalThis.__privateEvaluations++')
  const root = await fixture(t, {
    'private.ts': source,
    'ordinary.ts': 'globalThis.__ordinaryEvaluations++; export const value = 1',
  })
  const key = path.join(root, 'private.ts')
  const context = new IpcContext({})
  await context.registry.register(source, key, 'main')
  vi.stubGlobal('__privateEvaluations', 0)
  vi.stubGlobal('__ordinaryEvaluations', 0)
  t.onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    resolve: { alias: sourceAliases },
    server: { middlewareMode: true, ws: false },
    plugins: [providerTestPlugins(context)],
  })
  const dispatcher = await testDispatcher(t, server)
  t.onTestFinished(() => server.close())
  const call = (
    caller: 'main' | 'renderer',
    moduleKey = key,
    exportName = 'run',
  ) =>
    dispatcher.invoke({ caller, moduleKey, exportName }, undefined, undefined)
  await expect(call('renderer')).rejects.toThrow('Unknown IPC export')
  await expect(
    call('renderer', path.join(root, 'ordinary.ts')),
  ).rejects.toThrow('Unknown IPC export')
  await expect(
    call('renderer', 'data:text/javascript,globalThis.__ordinaryEvaluations++'),
  ).rejects.toThrow('Invalid IPC invocation target')
  expect((globalThis as any).__privateEvaluations).toBe(0)
  expect((globalThis as any).__ordinaryEvaluations).toBe(0)
  expect(await call('main')).toBe(42)
  await expect(call('renderer')).rejects.toThrow('Unknown IPC export')
  await expect(call('main', key, 'missing')).rejects.toThrow(
    'Unknown IPC export',
  )
  await context.registry.register(source, key, 'renderer')
  expect(await call('renderer')).toBe(42)
  expect((globalThis as any).__privateEvaluations).toBe(1)
  context.registry.remove(key, 'renderer')
  await expect(call('renderer')).rejects.toThrow('Unknown IPC export')
})
