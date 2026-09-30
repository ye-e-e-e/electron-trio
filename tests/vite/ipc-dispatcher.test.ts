import { expect, test, vi } from 'vitest'
import type { IpcDispatcher } from '#/runtime/ipc-dispatcher'
import { IPC_DISPATCHER_MODULE } from '#/vite/ipc-dispatcher-plugin/constants'
import type { IpcDispatcherModule } from '#/vite/ipc-dispatcher-plugin/dispatcher-module'
import { ipcDispatcherPlugin } from '#/vite/ipc-dispatcher-plugin/plugin'
import { fixture, mainRunner } from '../helpers'

test('dispatcher access requires injection and retains the injected instance', async (t) => {
  const root = await fixture(t, { 'main.ts': '' })
  const { runner } = await mainRunner(t, root, [ipcDispatcherPlugin()])
  const module = await runner.import<IpcDispatcherModule>(IPC_DISPATCHER_MODULE)
  expect(() => module.getDispatcher()).toThrow('not initialized')
  const dispatcher: IpcDispatcher = {
    invoke: vi.fn(),
  }
  module.setDispatcher(dispatcher)
  expect(module.getDispatcher()).toBe(dispatcher)
  expect(await runner.import(IPC_DISPATCHER_MODULE)).toBe(module)
})
