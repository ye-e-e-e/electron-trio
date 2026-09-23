import { expect, test, vi } from 'vitest'
import type { TestContext } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createServer } from 'vite'
import { DefinitionRegistry } from '#/compiler/registry'
import { DefinitionSources } from '#/context/definition-sources'
import { createIpcRuntime } from '#/runtime/ipc-runtime'
import type { ProviderRequest } from '#/runtime/protocol'
import { IpcEnvironment } from '#/vite/ipc-provider-plugin/environment'
import { fixture, sourceAliases } from '../helpers'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const implementation = (version: number) => `
  import { createIpcInvoke } from 'electron-ipc-invoke'
  let count = 0
  export const run = createIpcInvoke('run-${version}').handler(({ event, data }) => ({ version: ${version}, count: ++count, event, data }))
`

async function setup(t: TestContext, code = implementation(1)) {
  const root = await fixture(t, { 'main.ts': code, 'other.ts': implementation(100) })
  const moduleKey = path.join(root, 'main.ts')
  const otherKey = path.join(root, 'other.ts')
  const registry = new DefinitionRegistry()
  const sources = new DefinitionSources()
  for (const [key, source] of [[moduleKey, code], [otherKey, implementation(100)]]) {
    for (const caller of ['main', 'renderer'] as const) {
      await registry.register(source, key, caller)
      sources.track(key, caller)
    }
  }
  const server = await createServer({
    configFile: false, root, logLevel: 'silent', publicDir: false,
    resolve: { alias: sourceAliases },
    server: { middlewareMode: true, ws: false, watch: null },
    environments: { ipc_invoke: {
      consumer: 'server', keepProcessEnv: true,
      dev: { moduleRunnerTransform: true, createEnvironment(name, config) {
        return new IpcEnvironment(name, config, registry, sources)
      } },
    } },
  })
  const environment = server.environments.ipc_invoke as IpcEnvironment
  let intercept: ((request: ProviderRequest) => Promise<void>) | undefined
  const requests: ProviderRequest[] = []
  const invoke = environment.invoke.bind(environment)
  vi.spyOn(environment, 'invoke').mockImplementation(async request => {
    requests.push(request)
    await intercept?.(request)
    return invoke(request)
  })
  const connection = await environment.connection
  const runtime = await createIpcRuntime(connection)
  t.onTestFinished(async () => {
    vi.useRealTimers()
    await runtime.close()
    await server.close()
  })
  return {
    root, connection, runtime, moduleKey, otherKey, requests, environment,
    call: (key = moduleKey) => runtime.invoke({ caller: 'renderer', moduleKey: key, exportName: 'run' }, undefined, undefined),
    intercept(handler: typeof intercept) { intercept = handler },
    async replace(source: string, file = moduleKey) {
      await fs.writeFile(file, source)
      await environment.hotUpdate({
        type: 'update', file, timestamp: Date.now(), server,
        modules: [...environment.moduleGraph.getModulesByFile(file) ?? []],
        read: () => fs.readFile(file, 'utf8'),
      })
    },
  }
}

test('concurrent renderer and main calls share one module and use module requests without definition lookups', async t => {
  const app = await setup(t)
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => i % 2
    ? app.call()
    : app.runtime.invoke({ caller: 'main', moduleKey: app.moduleKey, exportName: 'run' }, undefined, i)))
  expect(results.map(result => (result as { count: number }).count).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  expect(app.requests.every(({ payload }) => payload.type === 'custom' && ['fetchModule', 'getBuiltins'].includes(payload.data.name))).toBe(true)
})

test('implementation modules update without an HMR context', async t => {
  const source = (value: number) => `
    import { createIpcInvoke } from 'electron-ipc-invoke'
    export const run = createIpcInvoke('run').handler(() => ({ value: ${value}, hasHot: import.meta.hot !== undefined }))
  `
  const app = await setup(t, source(1))
  expect(await app.call()).toEqual({ value: 1, hasHot: false })
  await app.replace(source(2))
  expect(await app.call()).toEqual({ value: 2, hasHot: false })
})

test('body and channel edits stay lazy and preserve independent module state', async t => {
  const app = await setup(t)
  expect(await app.call()).toMatchObject({ version: 1, count: 1 })
  expect(await app.call(app.otherKey)).toMatchObject({ count: 1 })
  const transform = vi.spyOn(app.environment, 'transformRequest')
  const requests = app.requests.length
  await app.replace(implementation(2))
  expect(transform).not.toHaveBeenCalled()
  expect(app.requests).toHaveLength(requests)
  expect(await app.call(app.otherKey)).toMatchObject({ count: 2 })
  expect(await app.call()).toMatchObject({ version: 2, count: 1 })
  expect(await app.call(app.otherKey)).toMatchObject({ count: 3 })
})

test('new code waits for existing calls to finish', async t => {
  const entered = deferred()
  const finish = deferred()
  vi.stubGlobal('__oldCall', async () => { entered.resolve(); await finish.promise })
  t.onTestFinished(() => { finish.resolve(); vi.unstubAllGlobals() })
  const app = await setup(t, `
    import { createIpcInvoke } from 'electron-ipc-invoke'
    export const run = createIpcInvoke('run').handler(async () => { await globalThis.__oldCall(); return { version: 1 } })
  `)
  const old = app.call()
  await entered.promise
  await app.replace(implementation(2))
  let completed = false
  const next = app.call().then(value => { completed = true; return value })
  expect(completed).toBe(false)
  finish.resolve()
  expect(await old).toEqual({ version: 1 })
  expect(await next).toMatchObject({ version: 2 })
})

test('updating an unloaded module preserves loaded independent module state', async t => {
  const app = await setup(t)
  expect(await app.call(app.otherKey)).toMatchObject({ version: 100, count: 1 })
  await app.replace(implementation(2))
  expect(await app.call()).toMatchObject({ version: 2 })
  expect(await app.call(app.otherKey)).toMatchObject({ version: 100, count: 2 })
})

test('syntax errors reject calls and repair loads new code without restarting the runtime', async t => {
  const app = await setup(t)
  await app.call()
  await app.replace('invalid syntax @@@')
  await expect(app.call()).rejects.toThrow()
  expect(await app.call(app.otherKey)).toMatchObject({ version: 100 })
  await app.replace(implementation(3))
  expect(await app.call()).toMatchObject({ version: 3 })
})

test('closing the service rejects outstanding module requests', async t => {
  const app = await setup(t)
  const entered = deferred()
  const blocked = deferred()
  t.onTestFinished(() => blocked.resolve())
  app.intercept(async () => { entered.resolve(); await blocked.promise })
  const call = expect(app.call()).rejects.toThrow('connection closed')
  await entered.promise
  await app.environment.close()
  await call
  blocked.resolve()
})

test('an unanswered module request times out', async t => {
  const app = await setup(t)
  const entered = deferred()
  const blocked = deferred()
  t.onTestFinished(() => blocked.resolve())
  app.intercept(async () => { entered.resolve(); await blocked.promise })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const call = expect(app.call()).rejects.toThrow('module request timed out')
  await entered.promise
  await vi.advanceTimersByTimeAsync(15_001)
  await call
  blocked.resolve()
})

test('shutdown waits for active handlers and rejects further calls', async t => {
  const entered = deferred()
  const finish = deferred()
  vi.stubGlobal('__closingCall', async () => { entered.resolve(); await finish.promise })
  t.onTestFinished(() => { finish.resolve(); vi.unstubAllGlobals() })
  const app = await setup(t, `
    import { createIpcInvoke } from 'electron-ipc-invoke'
    export const run = createIpcInvoke('run').handler(async () => { await globalThis.__closingCall(); return 42 })
  `)
  const call = app.call()
  await entered.promise
  const close = app.runtime.close()
  let closed = false
  void close.then(() => { closed = true })
  expect(app.runtime.close()).toBe(close)
  await expect(app.call()).rejects.toThrow('closed')
  expect(closed).toBe(false)
  finish.resolve()
  expect(await call).toBe(42)
  await close
  expect(app.runtime.close()).toBe(close)
  await expect(app.call()).rejects.toThrow('closed')
  expect(closed).toBe(true)
})

test('shutdown waits for in-progress module evaluation without executing its handler', async t => {
  const entered = deferred()
  const finish = deferred()
  const handler = vi.fn()
  vi.stubGlobal('__loadingModule', async () => { entered.resolve(); await finish.promise })
  vi.stubGlobal('__loadingHandler', handler)
  t.onTestFinished(() => { finish.resolve(); vi.unstubAllGlobals() })
  const app = await setup(t, `
    import { createIpcInvoke } from 'electron-ipc-invoke'
    await globalThis.__loadingModule()
    export const run = createIpcInvoke('run').handler(() => globalThis.__loadingHandler())
  `)
  const call = expect(app.call()).rejects.toThrow('closed')
  await entered.promise
  const close = app.runtime.close()
  let closed = false
  void close.then(() => { closed = true })
  expect(closed).toBe(false)
  finish.resolve()
  await call
  await close
  expect(handler).not.toHaveBeenCalled()
  expect(closed).toBe(true)
})

test('authentication rejects other clients and a replacement runtime starts with fresh state', async t => {
  const app = await setup(t)
  expect(await app.call()).toMatchObject({ count: 1 })
  await expect(createIpcRuntime({ ...app.connection, token: 'incorrect' })).rejects.toThrow('401')
  await app.runtime.close()
  const replacement = await createIpcRuntime(app.connection)
  t.onTestFinished(() => replacement.close())
  expect(await replacement.invoke({ caller: 'renderer', moduleKey: app.moduleKey, exportName: 'run' }, undefined, undefined)).toMatchObject({ count: 1 })
})


test('lazy dynamic dependencies and their importers update together', async t => {
  const definition = (channel: string) => `
    import { createIpcInvoke } from 'electron-ipc-invoke'
    let count = 0
    export const run = createIpcInvoke('${channel}').handler(async () => ({ value: (await import('./helper')).read(), count: ++count }))
  `
  const helper = (value: number) => `export const read = () => ${value}`
  const app = await setup(t, definition('first'))
  const file = path.join(app.root, 'helper.ts')
  await app.replace(helper(1), file)
  await app.replace(definition('other'), app.otherKey)
  expect(await app.call()).toEqual({ value: 1, count: 1 })
  expect(await app.call(app.otherKey)).toEqual({ value: 1, count: 1 })
  await app.replace(helper(2), file)
  expect(await app.call()).toEqual({ value: 2, count: 1 })
  expect(await app.call(app.otherKey)).toEqual({ value: 2, count: 1 })
})

test('a running handler can dynamically import its old dependency while another call prepares an update', async t => {
  const entered = deferred()
  const finish = deferred()
  let pause = false
  vi.stubGlobal('__beforeDynamicImport', async () => {
    if (pause) { entered.resolve(); await finish.promise }
  })
  t.onTestFinished(() => { finish.resolve(); vi.unstubAllGlobals() })
  const app = await setup(t, `
    import { createIpcInvoke } from 'electron-ipc-invoke'
    export const run = createIpcInvoke('dynamic').handler(async () => {
      await globalThis.__beforeDynamicImport()
      return (await import('./helper')).read()
    })
  `)
  const helper = (value: number) => `export const read = () => ${value}`
  const file = path.join(app.root, 'helper.ts')
  await app.replace(helper(1), file)
  expect(await app.call()).toBe(1)
  pause = true
  const old = app.call()
  await entered.promise
  await app.replace(helper(2), file)
  const next = app.call()
  pause = false
  finish.resolve()
  expect(await old).toBe(1)
  expect(await next).toBe(2)
})
