import { once } from 'node:events'
import WebSocket from 'ws'
import { expect, test, vi } from 'vitest'
import type { TestContext } from 'vitest'
import type { ProviderMessage, ProviderRequest } from '#/runtime/protocol'
import { createRpcServer } from '#/vite/ipc-provider-plugin/rpc-server'

async function connect(t: TestContext, server: ReturnType<typeof createRpcServer>) {
  t.onTestFinished(() => server.close())
  const connection = await server.ready
  const socket = new WebSocket(connection.url, { headers: { authorization: `Bearer ${connection.token}` } })
  t.onTestFinished(() => socket.terminate())
  await once(socket, 'open')
  return socket
}

function request(requestId: string): ProviderRequest {
  return { requestId, payload: { type: 'custom', event: 'vite:invoke', data: { name: 'getBuiltins', data: [] } } }
}

async function response(socket: WebSocket): Promise<ProviderMessage> {
  const [data] = await once(socket, 'message')
  return JSON.parse(data.toString())
}

test('concurrent responses keep their request IDs and invocation errors leave the connection usable', async t => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  t.onTestFinished(() => release())
  const socket = await connect(t, createRpcServer(async ({ requestId }) => {
    if (requestId === 'slow') await blocked
    if (requestId === 'failed') throw new Error('request failed')
    return { result: requestId }
  }))

  socket.send(JSON.stringify(request('slow')))
  let next = response(socket)
  socket.send(JSON.stringify(request('fast')))
  expect(await next).toEqual({ requestId: 'fast', response: { result: 'fast' } })

  next = response(socket)
  socket.send(JSON.stringify(request('failed')))
  expect(await next).toEqual({ requestId: 'failed', response: { error: { message: 'request failed' } } })

  next = response(socket)
  release()
  expect(await next).toEqual({ requestId: 'slow', response: { result: 'slow' } })
})

test.for(['invalid JSON', 'null', '{}'])('malformed request %s closes only its connection', async (data, t) => {
  const invoke = vi.fn(async () => ({ result: 42 }))
  const server = createRpcServer(invoke)
  const socket = await connect(t, server)
  const closed = once(socket, 'close')
  socket.send(data)
  expect((await closed)[0]).toBe(1003)
  expect(invoke).not.toHaveBeenCalled()

  const replacement = await connect(t, server)
  const next = response(replacement)
  replacement.send(JSON.stringify(request('replacement')))
  expect(await next).toEqual({ requestId: 'replacement', response: { result: 42 } })
})

test('closing during startup is idempotent and leaves no listening socket', async t => {
  const server = createRpcServer(async () => ({ result: null }))
  t.onTestFinished(() => server.close())
  const closed = server.close()
  expect(server.close()).toBe(closed)
  const connection = await server.ready
  await closed

  const socket = new WebSocket(connection.url, { headers: { authorization: `Bearer ${connection.token}` } })
  t.onTestFinished(() => socket.terminate())
  await expect(once(socket, 'open')).rejects.toThrow()
  expect(server.close()).toBe(closed)
})
