import { EventEmitter } from 'node:events'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import type { TestContext } from 'vitest'
import { PluginContext } from '#/context/context'
import type { IpcRuntime } from '#/runtime/ipc-runtime'
import { DEV_CHANNEL } from '#/vite/entry-plugin/constants'
import { mainPlugin } from '#/vite/plugin'
import { mainProxyPlugin } from '#/vite/main-proxy-plugin/plugin'
import { bundle, cjs, definition, entryCode, evaluate, fixture } from '../helpers'

async function buildMain(t: TestContext, initialize: boolean, loadRuntime?: () => Promise<IpcRuntime>) {
  const runtime: IpcRuntime = { invoke: vi.fn(async target => target), close: vi.fn(async () => {}) }
  const load = vi.fn(loadRuntime ?? (async () => runtime))
  const handlers = new Map<string, (event: unknown, moduleKey: unknown, exportName: unknown, input?: unknown) => Promise<unknown>>()
  const ipcMain = { handle: vi.fn((channel, handler) => handlers.set(channel, handler)), removeHandler: vi.fn(channel => handlers.delete(channel)) }
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() })
  const connection = { url: 'ws://127.0.0.1', token: 'test' }
  const context = new PluginContext({})
  context.command = 'serve'
  context.devConnection = Promise.resolve(connection)
  const root = await fixture(t, {
    'definition.ts': definition('business'),
    'main.ts': `
      import { run } from './definition'
      import * as calls from './definition'
      export { initRuntime, getRuntime } from 'electron-ipc-invoke/dev'
      export { run, calls }
      export const startupHandlers = globalThis.__handlerCount()
      export const startupCall = ${initialize ? 'run("startup")' : 'undefined'}
    `,
  })
  const output = await bundle(root, [{
    name: 'test:runtime', enforce: 'pre',
    resolveId(id) { if (id === 'electron-ipc-invoke/dev') return path.resolve('src/dev.ts') },
    load(id) { if (id === path.resolve('src/runtime/ipc-runtime.ts')) return 'export const createIpcRuntime = globalThis.__loadRuntime' },
  }, initialize ? mainPlugin(context) : mainProxyPlugin(context)], 'main.ts', {
    ...cjs(root, 'main.ts'), rolldownOptions: { external: ['electron'], output: { codeSplitting: false } },
  })
  const result = evaluate<typeof import('#/dev') & {
    run: (input?: unknown) => Promise<unknown>
    calls: { run: (input?: unknown) => Promise<unknown> }
    startupHandlers: number
    startupCall?: Promise<unknown>
  }>(entryCode(output), { ipcMain, app }, { console, __loadRuntime: load, __handlerCount: () => handlers.size })
  return { ...result, runtime, load, handlers, ipcMain, app, connection, moduleKey: path.join(root, 'definition.ts') }
}

test('main proxies can be created before shared runtime initialization without entry lifecycle hooks', async t => {
  const main = await buildMain(t, false)
  expect(main.startupHandlers).toBe(0)
  expect(main.app.listenerCount('before-quit')).toBe(0)
  expect(main.load).not.toHaveBeenCalled()
  expect(Object.keys(main.calls)).toEqual(['run'])
  await expect(main.run()).rejects.toThrow('not initialized')
  await main.initRuntime(main.connection)
  expect(await main.getRuntime()).toBe(main.runtime)
  await main.run(1)
  await main.calls.run(2)
  expect(main.load).toHaveBeenCalledExactlyOnceWith(main.connection)
  expect(main.runtime.invoke).toHaveBeenCalledWith({ caller: 'main', moduleKey: main.moduleKey, exportName: 'run' }, undefined, 1)
  expect(main.runtime.invoke).toHaveBeenCalledWith({ caller: 'main', moduleKey: main.moduleKey, exportName: 'run' }, undefined, 2)
  expect(main.ipcMain.handle).not.toHaveBeenCalled()
  await (await main.getRuntime()).close()
})

test('entry initialization shares the proxy runner and cleans up the dispatcher on quit', async t => {
  const main = await buildMain(t, true)
  expect(main.startupHandlers).toBe(1)
  expect(main.ipcMain.handle).toHaveBeenCalledTimes(1)
  expect(main.app.listenerCount('before-quit')).toBe(1)
  await main.startupCall
  expect(main.load).toHaveBeenCalledExactlyOnceWith(main.connection)
  expect(main.runtime.invoke).toHaveBeenCalledWith({ caller: 'main', moduleKey: main.moduleKey, exportName: 'run' }, undefined, 'startup')
  const event = { sender: { id: 1 } }
  await main.handlers.get(DEV_CHANNEL)!(event, main.moduleKey, 'run', 5)
  await main.run(4)
  await main.calls.run(3)
  expect(main.load).toHaveBeenCalledTimes(1)
  expect(main.runtime.invoke).toHaveBeenCalledWith({ caller: 'renderer', moduleKey: main.moduleKey, exportName: 'run' }, event, 5)
  expect(main.runtime.invoke).toHaveBeenCalledWith({ caller: 'main', moduleKey: main.moduleKey, exportName: 'run' }, undefined, 4)
  expect(main.runtime.invoke).toHaveBeenCalledWith({ caller: 'main', moduleKey: main.moduleKey, exportName: 'run' }, undefined, 3)
  await expect(main.handlers.get(DEV_CHANNEL)!(event, { caller: 'main', moduleKey: '/forged' }, 5)).rejects.toThrow('Invalid IPC invocation target')
  const quitEvent = { preventDefault: vi.fn() }
  main.app.emit('before-quit', quitEvent)
  await vi.waitFor(() => expect(main.app.quit).toHaveBeenCalledTimes(1))
  expect(quitEvent.preventDefault).toHaveBeenCalledTimes(1)
  expect(main.runtime.close).toHaveBeenCalledTimes(1)
  expect(main.ipcMain.removeHandler).toHaveBeenCalledExactlyOnceWith(DEV_CHANNEL)
  expect(main.app.listenerCount('before-quit')).toBe(0)
})

test('quit waits for pending runtime initialization before closing the instance', async t => {
  let resolve!: (runtime: IpcRuntime) => void
  const pending = new Promise<IpcRuntime>(done => { resolve = done })
  const main = await buildMain(t, true, () => pending)
  const quitEvent = { preventDefault: vi.fn() }
  main.app.emit('before-quit', quitEvent)
  expect(quitEvent.preventDefault).toHaveBeenCalledTimes(1)
  expect(main.ipcMain.removeHandler).toHaveBeenCalledExactlyOnceWith(DEV_CHANNEL)
  expect(main.runtime.close).not.toHaveBeenCalled()
  expect(main.app.quit).not.toHaveBeenCalled()
  resolve(main.runtime)
  await main.startupCall
  await vi.waitFor(() => expect(main.app.quit).toHaveBeenCalledTimes(1))
  expect(main.runtime.close).toHaveBeenCalledTimes(1)
})

test.for(['initialization', 'close'] as const)('quit completes even when runtime %s fails', async (stage, t) => {
  const error = new Error(`${stage} failed`)
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  let reject!: (error: Error) => void
  const pending = new Promise<IpcRuntime>((_, fail) => { reject = fail })
  const main = await buildMain(t, true, stage === 'initialization' ? () => pending : undefined)
  const startup = stage === 'initialization' ? expect(main.startupCall).rejects.toThrow(error) : main.startupCall
  if (stage === 'close') {
    await startup
    vi.mocked(main.runtime.close).mockRejectedValue(error)
  }
  main.app.emit('before-quit', { preventDefault: vi.fn() })
  if (stage === 'initialization') reject(error)
  await startup
  await vi.waitFor(() => expect(main.app.quit).toHaveBeenCalledTimes(1))
  expect(logged).toHaveBeenCalledWith(error)
  expect(main.runtime.close).toHaveBeenCalledTimes(stage === 'close' ? 1 : 0)
  expect(main.ipcMain.removeHandler).toHaveBeenCalledExactlyOnceWith(DEV_CHANNEL)
})
