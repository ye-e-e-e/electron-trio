import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { createServer } from 'vite'
import { DefinitionRegistry } from '#/compiler/registry'
import { createIpcRuntime } from '#/runtime/ipc-runtime'
import { DefinitionSources } from '#/context/definition-sources'
import { IpcEnvironment } from '#/vite/ipc-provider-plugin/environment'
import { fixture, sourceAliases } from '../helpers'

test.for([false, true])('edits during a module request use the latest source without proactive reload (failed source: %s)', async (fails, t) => {
  const source = (channel: string, value: number) => `import { createIpcInvoke } from 'electron-ipc-invoke'; export const run = createIpcInvoke('${channel}').handler(() => ${value})`
  const root = await fixture(t, { 'a.ts': source('a', 1), 'b.ts': source('b', 1) })
  const a = path.join(root, 'a.ts')
  const b = path.join(root, 'b.ts')
  const registry = new DefinitionRegistry()
  const sources = new DefinitionSources()
  for (const [key, channel] of [[a, 'a'], [b, 'b']]) {
    await registry.register(source(channel, 1), key, 'renderer')
    sources.track(key, 'renderer')
  }
  let start!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  let block = false
  const server = await createServer({
    configFile: false, root, publicDir: false, logLevel: 'silent',
    resolve: { alias: sourceAliases },
    server: { middlewareMode: true, ws: false, watch: null },
    environments: { ipc_invoke: {
      consumer: 'server',
      dev: { moduleRunnerTransform: true, createEnvironment(name, config) {
        return new IpcEnvironment(name, config, registry, sources)
      } },
    } },
    plugins: [{
      name: 'test:hold-first-transform',
      async transform(_code, id) {
        if (id !== a || !block) return
        block = false
        start()
        await blocked
      },
    }],
  })
  const environment = server.environments.ipc_invoke as IpcEnvironment
  const runtime = await createIpcRuntime(await environment.connection)
  t.onTestFinished(async () => {
    release()
    await runtime.close()
    await server.close()
  })
  const call = (moduleKey: string) => runtime.invoke({ caller: 'renderer', moduleKey, exportName: 'run' }, undefined, undefined)
  const update = async (file: string, code: string) => {
    await fs.writeFile(file, code)
    await environment.hotUpdate({
      type: 'update', file, timestamp: Date.now(), server,
      modules: [...environment.moduleGraph.getModulesByFile(file) ?? []],
      read: () => fs.readFile(file, 'utf8'),
    })
  }
  expect(await call(a)).toBe(1)
  expect(await call(b)).toBe(1)
  block = true
  await update(a, source('a', 2))
  expect(block).toBe(true)
  const result = fails ? expect(call(a)).rejects.toThrow() : expect(call(a)).resolves.toBe(4)
  await started
  await update(a, source('a', 3))
  await update(b, source('b', 2))
  await update(a, fails ? 'invalid syntax @@@' : source('renamed', 4))
  release()
  await result
  expect(await call(b)).toBe(2)
  await update(a, source('repaired', 5))
  expect(await call(a)).toBe(5)
})

test('module requests wait for missing dependency recovery to finish', async t => {
  const root = await fixture(t)
  let start!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const server = await createServer({
    configFile: false, root, publicDir: false, logLevel: 'silent',
    server: { middlewareMode: true, ws: false, watch: null },
    environments: { ipc_invoke: {
      consumer: 'server',
      dev: { createEnvironment(name, config) {
        return new IpcEnvironment(name, config, new DefinitionRegistry(), new DefinitionSources())
      } },
    } },
    plugins: [{
      name: 'test:hold-dependency-recovery',
      async resolveId(source) {
        if (source !== './missing') return
        start()
        await blocked
        return '\0recovered'
      },
    }],
  })
  t.onTestFinished(async () => {
    release()
    await server.close()
  })
  const environment = server.environments.ipc_invoke as IpcEnvironment
  await environment.resolveImport('./missing', path.join(root, 'definition.ts'), async () => null)
  const update = environment.hotUpdate({
    type: 'create', file: path.join(root, 'missing.ts'), timestamp: Date.now(), server,
    modules: [], read: () => '',
  })
  await started
  const invoke = vi.spyOn(environment.hot, 'handleInvoke')
  const result = environment.invoke({
    requestId: 'builtins',
    payload: { type: 'custom', event: 'vite:invoke', data: { name: 'getBuiltins', data: [] } },
  })
  await Promise.resolve()
  expect(invoke).not.toHaveBeenCalled()
  release()
  await update
  await expect(result).resolves.toMatchObject({ result: expect.any(Array) })
  expect(invoke).toHaveBeenCalledTimes(1)
})
