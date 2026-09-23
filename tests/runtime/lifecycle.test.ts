import { beforeEach, expect, test, vi } from 'vitest'
import { createIpcRuntime } from '#/runtime/ipc-runtime'
import type { IpcRuntime } from '#/runtime/ipc-runtime'

vi.mock('#/runtime/ipc-runtime', () => ({ createIpcRuntime: vi.fn() }))

const connection = { url: 'ws://127.0.0.1', token: 'test' }

beforeEach(() => {
  vi.resetModules()
  vi.mocked(createIpcRuntime).mockReset()
})

test('runtime access requires explicit initialization and shares one instance', async () => {
  const runtime: IpcRuntime = { invoke: vi.fn(), close: vi.fn(async () => {}) }
  vi.mocked(createIpcRuntime).mockResolvedValue(runtime)
  const { initRuntime, getRuntime } = await import('#/runtime/index')
  await expect(getRuntime()).rejects.toThrow('not initialized')
  expect(createIpcRuntime).not.toHaveBeenCalled()
  const initialized = initRuntime(connection)
  expect(initRuntime(connection)).toBe(initialized)
  expect(getRuntime()).toBe(initialized)
  await expect(getRuntime()).resolves.toBe(runtime)
  expect(createIpcRuntime).toHaveBeenCalledExactlyOnceWith(connection)
  await (await getRuntime()).close()
  expect(runtime.close).toHaveBeenCalledTimes(1)
  expect(getRuntime()).toBe(initialized)
  expect(initRuntime(connection)).toBe(initialized)
  await expect(getRuntime()).resolves.toBe(runtime)
  expect(createIpcRuntime).toHaveBeenCalledTimes(1)
})

test.for([false, true])('runtime access shares pending initialization and its result (initialization fails: %s)', async fails => {
  const runtime: IpcRuntime = { invoke: vi.fn(), close: vi.fn(async () => {}) }
  let resolve!: (value: IpcRuntime) => void
  let reject!: (error: Error) => void
  vi.mocked(createIpcRuntime).mockReturnValue(new Promise<IpcRuntime>((done, fail) => { resolve = done; reject = fail }))
  const { initRuntime, getRuntime } = await import('#/runtime/index')
  const initialized = initRuntime(connection)
  expect(getRuntime()).toBe(initialized)
  expect(initRuntime(connection)).toBe(initialized)
  const result = fails ? expect(getRuntime()).rejects.toThrow('initialization failed') : expect(getRuntime()).resolves.toBe(runtime)
  if (fails) reject(new Error('initialization failed'))
  else resolve(runtime)
  await result
  expect(getRuntime()).toBe(initialized)
  expect(initRuntime(connection)).toBe(initialized)
  expect(createIpcRuntime).toHaveBeenCalledExactlyOnceWith(connection)
})
