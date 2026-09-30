import { EventEmitter } from 'node:events'
import { expect, test, vi } from 'vitest'
import { createConnection } from '#/runtime/connection'
import { VALIDATE_REQUEST, VALIDATE_RESPONSE } from '#/runtime/protocol'

function setup() {
  const channel = Object.assign(new EventEmitter(), {
    connected: true,
    send: vi.fn(),
  })
  const { transport, validate } = createConnection(
    channel as unknown as NodeJS.Process,
  )
  const handlers = { onMessage: vi.fn(), onDisconnection: vi.fn() }
  transport.connect!(handlers)
  const reply = (data: object) =>
    channel.emit('message', {
      type: 'runner:message',
      payload: { type: 'custom', event: VALIDATE_RESPONSE, data },
    })
  return { channel, transport, validate, handlers, reply }
}
const target = {
  caller: 'renderer' as const,
  moduleKey: '/functions.ts',
  exportName: 'run',
}

test('validation responses are correlated separately from runner RPC and HMR', async () => {
  const app = setup()
  const first = app.validate(target)
  const second = expect(app.validate(target)).rejects.toThrow(
    'Unknown IPC export',
  )
  expect(app.channel.send).toHaveBeenCalledWith(
    {
      type: 'runner:message',
      payload: {
        type: 'custom',
        event: VALIDATE_REQUEST,
        data: { id: 1, target },
      },
    },
    expect.any(Function),
  )
  app.reply({ id: 2, error: 'Unknown IPC export' })
  app.reply({ id: 1 })
  await Promise.all([first, second])
  expect(app.handlers.onMessage).not.toHaveBeenCalled()
  const payload = { type: 'update', updates: [] }
  app.channel.emit('message', { type: 'runner:message', payload })
  expect(app.handlers.onMessage).toHaveBeenCalledWith(payload)
  await app.transport.disconnect!()
  expect(app.channel.listenerCount('message')).toBe(0)
})

test('disconnection rejects pending validation and removes listeners', async () => {
  const app = setup()
  const result = expect(app.validate(target)).rejects.toThrow(
    'connection is closed',
  )
  app.channel.connected = false
  app.channel.emit('disconnect')
  await result
  await expect(app.validate(target)).rejects.toThrow('connection is closed')
  expect(app.handlers.onDisconnection).toHaveBeenCalledOnce()
  expect(app.channel.listenerCount('message')).toBe(0)
})

test('unanswered validation times out', async () => {
  vi.useFakeTimers()
  const app = setup()
  try {
    const result = expect(app.validate(target)).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(15001)
    await result
  } finally {
    await app.transport.disconnect!()
    vi.useRealTimers()
  }
})
