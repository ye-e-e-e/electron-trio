import { EventEmitter } from 'node:events'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import type { TestContext } from 'vitest'
import { createIpcInvoke } from '#/index'
import type { IpcDispatcher } from '#/runtime/ipc-dispatcher'
import { IPC_DISPATCHER_MODULE } from '#/vite/ipc-dispatcher-plugin/constants'

const mocks = vi.hoisted(() => ({
  app: undefined as unknown as EventEmitter & {
    setAppPath: () => void
    setName: () => void
    setVersion: () => void
    quit: () => void
    exit: (code?: number) => void
  },
  readMetadata: vi.fn(),
  runner: { create: vi.fn(), import: vi.fn(), close: vi.fn() },
}))

vi.mock('node:fs/promises', () => ({
  default: { readFile: mocks.readMetadata },
}))
vi.mock('electron', () => ({
  get app() {
    return mocks.app
  },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('vite/module-runner', () => ({
  ModuleRunner: class {
    constructor() {
      mocks.runner.create()
    }
    import = mocks.runner.import
    close = mocks.runner.close
  },
  createNodeImportMeta: vi.fn(),
}))
vi.mock('#/runtime/connection', () => ({
  createConnection: () => ({ transport: {}, validate: async () => {} }),
}))

function setup(t: TestContext) {
  vi.resetModules()
  mocks.readMetadata.mockReset().mockResolvedValue('{}')
  mocks.runner.create.mockReset()
  mocks.runner.import.mockReset()
  mocks.runner.close.mockReset()
  const exited = vi.fn()
  const app = Object.assign(new EventEmitter(), {
    setAppPath() {},
    setName() {},
    setVersion() {},
    quit: vi.fn(() => {
      for (const name of ['before-quit', 'will-quit']) {
        const event = {
          defaultPrevented: false,
          preventDefault() {
            this.defaultPrevented = true
          },
        }
        app.emit(name, event)
        if (event.defaultPrevented) return
      }
      exited()
    }),
    exit: exited,
  })
  mocks.app = app
  const root = path.resolve(import.meta.dirname, '../..')
  const entry = path.join(root, 'main.ts')
  let dispatcher!: IpcDispatcher
  const onMain = vi.fn()
  const run = createIpcInvoke('run').handler(() => 42)
  mocks.runner.import.mockImplementation(async (id: string) => {
    if (id === IPC_DISPATCHER_MODULE)
      return {
        setDispatcher(value: IpcDispatcher) {
          dispatcher = value
        },
      }
    if (id === entry) {
      onMain()
      return {}
    }
    return { run }
  })
  vi.stubEnv('ELECTRON_START_RUNNER', JSON.stringify({ root, entry }))
  const messageListeners = new Set(process.listeners('message'))
  const disconnectListeners = new Set(process.listeners('disconnect'))
  t.onTestFinished(() => {
    for (const listener of process.listeners('message'))
      if (!messageListeners.has(listener)) process.off('message', listener)
    for (const listener of process.listeners('disconnect'))
      if (!disconnectListeners.has(listener))
        process.off('disconnect', listener)
    vi.unstubAllEnvs()
  })
  const invoke = () =>
    dispatcher.invoke(
      {
        caller: 'main',
        moduleKey: path.join(root, 'functions.ts'),
        exportName: 'run',
      },
      undefined,
      undefined,
    )
  const disconnect = () => {
    // Call only bootstrap's listener, leaving Vitest's process IPC intact.
    const listener = process
      .listeners('disconnect')
      .find((listener) => !disconnectListeners.has(listener))
    expect(listener).toBeDefined()
    listener!()
  }
  return { app, exited, onMain, invoke, disconnect }
}

test.for(['before-quit', 'will-quit'] as const)(
  'cancelling %s keeps the application and IPC runtime available',
  async (cancelEvent, t) => {
    const { app, exited, onMain, invoke } = setup(t)
    onMain.mockImplementation(() => {
      app.on(cancelEvent, (event) => event.preventDefault())
    })
    await import('#/runtime/bootstrap')
    expect(await invoke()).toBe(42)
    app.quit()
    expect(await invoke()).toBe(42)
    expect(exited).not.toHaveBeenCalled()
    expect(mocks.runner.close).not.toHaveBeenCalled()
  },
)

test.for(['initialization', 'main'] as const)(
  'parent disconnection during %s exits without allowing cancellation',
  async (phase, t) => {
    const { app, exited, disconnect } = setup(t)
    app.on('before-quit', (event) => event.preventDefault())
    if (phase === 'initialization')
      mocks.readMetadata.mockImplementationOnce(async () => {
        disconnect()
        return '{}'
      })
    await import('#/runtime/bootstrap')
    if (phase === 'main') disconnect()
    expect(exited).toHaveBeenCalledExactlyOnceWith()
    expect(app.quit).not.toHaveBeenCalled()
    expect(mocks.runner.close).not.toHaveBeenCalled()
  },
)

test.for(['config', 'metadata', 'runner', 'main'] as const)(
  '%s initialization failures are logged and exit with code 1',
  async (phase, t) => {
    const { exited, onMain } = setup(t)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    if (phase === 'config') vi.stubEnv('ELECTRON_START_RUNNER', '{')
    if (phase === 'metadata') mocks.readMetadata.mockResolvedValueOnce('{')
    const fail = () => {
      throw new Error('startup failed')
    }
    if (phase === 'runner') mocks.runner.create.mockImplementationOnce(fail)
    if (phase === 'main') onMain.mockImplementationOnce(fail)
    await import('#/runtime/bootstrap')
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.any(Error))
    expect(exited).toHaveBeenCalledExactlyOnceWith(1)
    if (phase !== 'main') expect(onMain).not.toHaveBeenCalled()
  },
)

test('a missing package.json still allows main to load', async (t) => {
  const { exited, onMain, invoke } = setup(t)
  mocks.readMetadata.mockRejectedValueOnce(
    Object.assign(new Error('missing package.json'), { code: 'ENOENT' }),
  )
  await import('#/runtime/bootstrap')
  expect(onMain).toHaveBeenCalledOnce()
  expect(await invoke()).toBe(42)
  expect(exited).not.toHaveBeenCalled()
})
