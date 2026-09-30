import { expect, test, vi } from 'vitest'
import { createIpcInvoke } from '#/index'
import { createIpcDispatcher } from '#/runtime/ipc-dispatcher'

const target = {
  caller: 'main' as const,
  moduleKey: '/main/functions.ts',
  exportName: 'run',
}

test('main and renderer calls use the supplied runner and authorize every call, including cache hits', async () => {
  let count = 0
  const exports = {
    run: createIpcInvoke('count').handler(({ event }) => ({
      count: ++count,
      event,
    })),
  }
  const runner = { import: vi.fn().mockResolvedValue(exports) }
  const validate = vi.fn(async () => {})
  const dispatcher = createIpcDispatcher({ runner, validate })
  const event = { sender: { id: 1 } } as Electron.IpcMainInvokeEvent
  expect(await dispatcher.invoke(target, undefined, undefined)).toEqual({
    count: 1,
    event: undefined,
  })
  expect(
    await dispatcher.invoke(
      { ...target, caller: 'renderer' },
      event,
      undefined,
    ),
  ).toEqual({ count: 2, event })
  expect(runner.import).toHaveBeenCalledTimes(2)
  expect(runner.import).toHaveBeenCalledWith(
    target.moduleKey + '?ipc-implementation',
  )
  expect(validate).toHaveBeenCalledTimes(2)
  validate.mockRejectedValueOnce(new Error('Unknown IPC export'))
  await expect(dispatcher.invoke(target, undefined, undefined)).rejects.toThrow(
    'Unknown IPC export',
  )
  expect(runner.import).toHaveBeenCalledTimes(2)
})

test('invalid targets and missing definitions reject without invoking arbitrary exports', async () => {
  const ordinary = vi.fn()
  const runner = { import: vi.fn().mockResolvedValue({ run: ordinary }) }
  const validate = vi.fn(async () => {})
  const dispatcher = createIpcDispatcher({ runner, validate })
  await expect(
    dispatcher.invoke(
      { ...target, moduleKey: 'data:text/javascript,1' },
      undefined,
      undefined,
    ),
  ).rejects.toThrow('Invalid IPC invocation target')
  expect(validate).not.toHaveBeenCalled()
  expect(runner.import).not.toHaveBeenCalled()
  await expect(dispatcher.invoke(target, undefined, undefined)).rejects.toThrow(
    'unavailable',
  )
  expect(ordinary).not.toHaveBeenCalled()
})

test('an active handler can call another definition without a module loading lock', async () => {
  const runner = { import: vi.fn() }
  const dispatcher = createIpcDispatcher({
    runner,
    validate: async () => {},
  })
  const inner = createIpcInvoke('inner').handler(() => 42)
  const outer = createIpcInvoke('outer').handler(() =>
    dispatcher.invoke({ ...target, exportName: 'inner' }, undefined, undefined),
  )
  runner.import.mockResolvedValue({ run: outer, inner })
  expect(await dispatcher.invoke(target, undefined, undefined)).toBe(42)
})
