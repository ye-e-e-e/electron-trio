import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { IPC_DISPATCHER_MODULE } from '#/vite/ipc-dispatcher-plugin/constants'
import type { IpcDispatcherModule } from '#/vite/ipc-dispatcher-plugin/dispatcher-module'
import { ipcDispatcherPlugin } from '#/vite/ipc-dispatcher-plugin/plugin'
import { DEV_CHANNEL } from '#/vite/ipc-entry-plugin/constants'
import { ipcEntryPlugin } from '#/vite/ipc-entry-plugin/plugin'
import { ipcMainPlugin } from '#/vite/ipc-main-plugin/plugin'
import { IpcContext } from '#/vite/ipc-plugin/context'
import { ipcPlugin } from '#/vite/ipc-plugin/plugin'
import { definition, fixture, mainRunner } from '../helpers'

test('development rejects an IPC definition used as the application entry before proxy generation', async (t) => {
  const root = await fixture(t, { 'main.ts': definition('entry') })
  const { runner } = await mainRunner(t, root, ipcPlugin({}))
  await expect(runner.import(path.join(root, 'main.ts'))).rejects.toThrow(
    'An IPC definition cannot also be a main/preload entry',
  )
})

test('development entry registers the renderer dispatcher before application calls and uses the bootstrap dispatcher', async (t) => {
  const root = await fixture(t, {
    'definition.ts': definition('business'),
    'main.ts': `import { run } from './definition'; export const startup = run(); export { run }`,
  })
  const context = new IpcContext({})
  const dispatcher = { invoke: vi.fn(async () => 42) }
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const ipcMain = {
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
  }
  vi.stubGlobal('__entryMocks', { ipcMain })
  const { runner } = await mainRunner(t, root, [
    {
      name: 'test:entry-runtime',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'electron') return '\0test:entry-runtime'
      },
      load(id) {
        if (id === '\0test:entry-runtime')
          return 'export const { ipcMain } = globalThis.__entryMocks'
      },
    },
    ipcDispatcherPlugin(),
    ipcMainPlugin(context),
    ipcEntryPlugin(context),
  ])
  const dispatcherModule = await runner.import<IpcDispatcherModule>(
    IPC_DISPATCHER_MODULE,
  )
  dispatcherModule.setDispatcher(dispatcher)
  const api = await runner.import<{
    startup: Promise<unknown>
    run(): Promise<unknown>
  }>(path.join(root, 'main.ts'))
  expect(await api.startup).toBe(42)
  expect(ipcMain.handle).toHaveBeenCalledOnce()
  expect(dispatcher.invoke).toHaveBeenCalledWith(
    {
      caller: 'main',
      moduleKey: path.join(root, 'definition.ts'),
      exportName: 'run',
    },
    undefined,
    undefined,
  )
  const event = { sender: { id: 1 } }
  expect(
    await handlers.get(DEV_CHANNEL)!(
      event,
      path.join(root, 'definition.ts'),
      'run',
      5,
    ),
  ).toBe(42)
  expect(dispatcher.invoke).toHaveBeenCalledWith(
    {
      caller: 'renderer',
      moduleKey: path.join(root, 'definition.ts'),
      exportName: 'run',
    },
    event,
    5,
  )
  await expect(
    handlers.get(DEV_CHANNEL)!(
      event,
      { caller: 'main', moduleKey: '/forged' },
      'run',
    ),
  ).rejects.toThrow('Invalid IPC invocation target')
})
