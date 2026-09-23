import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { createServer } from 'vite'
import { rendererPlugin } from '#/vite/plugin'
import { createIpcRuntime } from '#/runtime/ipc-runtime'
import { PluginContext } from '#/context/context'
import { fixture, sourceAliases, until } from '../helpers'

const source = (value: number) => `import { createIpcInvoke } from 'electron-ipc-invoke';
import { suffix } from '@main-helper';
import { identity } from './identity';
import { existsSync } from 'node:fs';
import { basename } from 'path';
if (!existsSync(import.meta.filename) || basename(import.meta.filename) !== 'functions.ts') throw new Error('Node builtins unavailable');
if (basename(identity) !== 'identity.ts') throw new Error('Application preserveSymlinks was not retained');
let count = 0;
export const run = createIpcInvoke('run').handler(() => ({ value: ${value}, count: ++count, suffix, defined: __IPC_TEST__ }))`

test('IPC provider uses application plugins and the application server owns its lifecycle', async t => {
  const definition = "import { value } from 'virtual:application-value'; import { createIpcInvoke } from 'electron-ipc-invoke'; export const run = createIpcInvoke('run').handler(() => value)"
  const root = await fixture(t, { 'definition.ts': definition })
  const key = path.join(root, 'definition.ts')
  const context = new PluginContext({})
  await context.registry.register(definition, key, 'main')
  context.sources.track(key, 'main')
  const server = await createServer({
    root, configFile: false, logLevel: 'silent', resolve: { alias: sourceAliases },
    plugins: [rendererPlugin(context), {
      name: 'application-value',
      resolveId(id) { if (id === 'virtual:application-value') return '\0' + id },
      load(id) { if (id === '\0virtual:application-value') return 'export const value = APPLICATION_VALUE' },
      transform(code, id) { if (id === '\0virtual:application-value') return code.replace('APPLICATION_VALUE', '42') },
    }],
    server: { middlewareMode: true, ws: false },
  })
  t.onTestFinished(() => server.close())
  const runtime = await createIpcRuntime(await context.devConnection!)
  t.onTestFinished(() => runtime.close())
  expect(server.environments.ipc_invoke).toBeDefined()
  expect(server.environments.ipc_invoke.moduleGraph).not.toBe(server.environments.client.moduleGraph)
  const close = vi.spyOn(server.environments.ipc_invoke, 'close')
  expect((await server.transformRequest('/definition.ts'))?.code).toContain('createDevRendererInvoker')
  expect(await runtime.invoke({ caller: 'main', moduleKey: key, exportName: 'run' }, undefined, undefined)).toBe(42)

  const connection = await context.devConnection!
  const previousWatch = vi.spyOn(server.watcher, 'add')
  await server.restart()
  expect(close).toHaveBeenCalledTimes(1)
  expect((await context.devConnection!).token).not.toBe(connection.token)
  await expect(createIpcRuntime(connection)).rejects.toThrow()
  previousWatch.mockClear()
  const currentWatch = vi.spyOn(server.watcher, 'add')
  const discovered = path.join(root, 'discovered.ts')
  context.sources.watch(discovered)
  expect(previousWatch).not.toHaveBeenCalled()
  expect(currentWatch).toHaveBeenCalledWith(discovered)
  const nextRuntime = await createIpcRuntime(await context.devConnection!)
  t.onTestFinished(() => nextRuntime.close())
  expect(await nextRuntime.invoke({ caller: 'main', moduleKey: key, exportName: 'run' }, undefined, undefined)).toBe(42)
  const closeRestarted = vi.spyOn(server.environments.ipc_invoke, 'close')
  await server.close()
  expect(closeRestarted).toHaveBeenCalledTimes(1)
  currentWatch.mockClear()
  context.sources.watch(path.join(root, 'after-close.ts'))
  expect(currentWatch).not.toHaveBeenCalled()
})

test('implementation environment uses application HMR and preserves encountered callers', { timeout: 30000 }, async t => {
  const root = await fixture(t, {
    'package.json': '{"type":"module"}',
    'index.html': '',
    'functions.ts': source(1),
    'helper.ts': 'export const suffix = "first"',
    'real-identity.ts': 'export const identity = import.meta.filename',
    'unrelated.ts': "import { createIpcInvoke } from 'electron-ipc-invoke'; export const unrelated = createIpcInvoke('other').handler(() => 'ok')",
    'undiscovered.ts': 'invalid source @@@',
  })
  await fs.symlink(path.join(root, 'real-identity.ts'), path.join(root, 'identity.ts'))
  const key = path.join(root, 'functions.ts')
  const other = path.join(root, 'unrelated.ts')
  const context = new PluginContext({})
  const registry = context.registry
  await registry.register(source(1), key, 'main')
  await registry.register(source(1), key, 'renderer')
  await registry.register(await fs.readFile(other, 'utf8'), other, 'main')
  const server = await createServer({
    configFile: false, root, logLevel: 'silent', appType: 'custom',
    plugins: [rendererPlugin(context)],
    resolve: { alias: [...sourceAliases, { find: '@main-helper', replacement: path.join(root, 'helper.ts') }], preserveSymlinks: true },
    define: { __IPC_TEST__: '"application"' },
    server: { middlewareMode: true, ws: false },
    environments: { ipc_invoke: { define: { __IPC_TEST__: '"defined"' }, resolve: { conditions: ['custom-runner'] } } },
  })
  t.onTestFinished(() => server.close())
  context.sources.track(key, 'main')
  context.sources.track(key, 'renderer')
  context.sources.track(other, 'main')
  const connection = await context.devConnection!
  const runtime = await createIpcRuntime(connection)
  t.onTestFinished(() => runtime.close())
  const local = () => runtime.invoke({ caller: 'main', moduleKey: key, exportName: 'run' }, undefined, undefined)
  const remote = () => runtime.invoke({ caller: 'renderer', moduleKey: key, exportName: 'run' }, undefined, undefined)
  expect(await local()).toEqual({ value: 1, count: 1, suffix: 'first', defined: 'defined' })
  expect(await remote()).toMatchObject({ count: 2 })
  let revision = registry.revision
  await fs.writeFile(key, source(2))
  await until(() => registry.revision > revision, 'function body update')
  expect(await remote()).toMatchObject({ value: 2 })
  revision = registry.revision
  await fs.writeFile(path.join(root, 'helper.ts'), 'export const suffix = "second"')
  await until(() => registry.revision > revision, 'dependency update')
  expect(await local()).toMatchObject({ suffix: 'second' })
  await fs.writeFile(key, source(3) + '\ninvalid @@@')
  await until(async () => { try { await local(); return false } catch { return true } }, 'syntax failure')
  expect(await runtime.invoke({ caller: 'main', moduleKey: other, exportName: 'unrelated' }, undefined, undefined)).toBe('ok')
  revision = registry.revision
  await fs.writeFile(key, source(4))
  await until(() => registry.revision > revision, 'syntax repair')
  expect(await remote()).toMatchObject({ value: 4 })
  expect([...registry.callers(key)].sort()).toEqual(['main', 'renderer'])
  expect([...registry.callers(other)]).toEqual(['main'])
  await expect(runtime.invoke({ caller: 'renderer', moduleKey: other, exportName: 'unrelated' }, undefined, undefined)).rejects.toThrow('Unknown IPC export')
  // Renderer HMR may process deletion before implementation HMR.
  registry.remove(key, 'renderer')
  await fs.unlink(key)
  await until(() => !registry.read(key), 'definition deletion')
  await expect(local()).rejects.toThrow()
  revision = registry.revision
  await fs.writeFile(key, source(5))
  await until(() => registry.revision > revision, 'definition restoration')
  expect(await remote()).toMatchObject({ value: 5 })
  await fs.writeFile(key, source(6))
  await fs.writeFile(key, source(7))
  await until(async () => (await remote() as { value: number }).value === 7, 'rapid update')
  registry.setActive('main', [other])
  context.sources.setActive('main', [other])
  revision = registry.revision
  await fs.unlink(key)
  await until(() => registry.revision > revision, 'removed definition failure')
  revision = registry.revision
  await fs.writeFile(key, source(8))
  await until(() => registry.revision > revision, 'renderer-only restoration')
  expect(await remote()).toMatchObject({ value: 8 })
  await expect(local()).rejects.toThrow('Unknown IPC export')
  expect([...registry.callers(key)]).toEqual(['renderer'])
})


test('module requests validate renderer targets before evaluation, including cache hits', async t => {
  const create = (effect: string) => `import { createIpcInvoke } from 'electron-ipc-invoke'; ${effect}; export const run = createIpcInvoke('private').handler(() => 42)`
  const source = create('globalThis.__privateEvaluations++')
  const root = await fixture(t, {
    'private.ts': source,
    'ordinary.ts': 'globalThis.__ordinaryEvaluations++; export const value = 1',
  })
  const key = path.join(root, 'private.ts')
  const context = new PluginContext({})
  await context.registry.register(source, key, 'main')
  context.sources.track(key, 'main')
  vi.stubGlobal('__privateEvaluations', 0)
  vi.stubGlobal('__ordinaryEvaluations', 0)
  t.onTestFinished(() => { vi.unstubAllGlobals() })
  const server = await createServer({
    configFile: false, root, logLevel: 'silent', resolve: { alias: sourceAliases },
    server: { middlewareMode: true, ws: false }, plugins: [rendererPlugin(context)],
  })
  const runtime = await createIpcRuntime(await context.devConnection!)
  t.onTestFinished(async () => { await runtime.close(); await server.close() })
  const call = (caller: 'main' | 'renderer', moduleKey = key, exportName = 'run') => runtime.invoke({ caller, moduleKey, exportName }, undefined, undefined)
  await expect(call('renderer')).rejects.toThrow('Unknown IPC export')
  await expect(call('renderer', path.join(root, 'ordinary.ts'))).rejects.toThrow('Unknown IPC export')
  await expect(call('renderer', 'data:text/javascript,globalThis.__ordinaryEvaluations++')).rejects.toThrow('Invalid IPC invocation target')
  expect((globalThis as any).__privateEvaluations).toBe(0)
  expect((globalThis as any).__ordinaryEvaluations).toBe(0)
  expect(await call('main')).toBe(42)
  await expect(call('renderer')).rejects.toThrow('Unknown IPC export')
  await expect(call('main', key, 'missing')).rejects.toThrow('Unknown IPC export')
  await context.registry.register(source, key, 'renderer')
  expect(await call('renderer')).toBe(42)
  expect((globalThis as any).__privateEvaluations).toBe(1)
  context.registry.remove(key, 'renderer')
  await expect(call('renderer')).rejects.toThrow('Unknown IPC export')
})
