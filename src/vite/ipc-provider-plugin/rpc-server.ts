import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { RawData } from 'ws'
import type { DevConnectionInfo, InvokeResponse, ProviderRequest } from '#/runtime/protocol'

const LOOPBACK_HOST = '127.0.0.1'

/** Authenticated WebSocket RPC endpoint; module handling belongs to the caller. */
export function createRpcServer(invoke: (request: ProviderRequest) => Promise<InvokeResponse>) {
  const token = randomBytes(32).toString('hex')
  const expected = Buffer.from(`Bearer ${token}`)
  const server = new WebSocketServer({
    host: LOOPBACK_HOST, port: 0,
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      const supplied = Buffer.from(req.headers.authorization ?? '')
      return supplied.length === expected.length && timingSafeEqual(supplied, expected)
    },
  })
  const ready = new Promise<DevConnectionInfo>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('IPC development socket has no address'))
      resolve({ url: `ws://${LOOPBACK_HOST}:${address.port}`, token })
    })
  })
  server.on('connection', socket => {
    socket.on('error', () => {})
    socket.on('message', data => { void handleMessage(socket, data) })
  })
  let closePromise: Promise<void> | undefined

  return {
    ready,
    close() {
      return closePromise ??= (async () => {
        await ready.catch(() => {})
        for (const socket of server.clients) socket.terminate()
        await new Promise<void>(resolve => server.close(() => resolve()))
      })()
    },
  }

  async function handleMessage(socket: WebSocket, data: RawData) {
    let request: ProviderRequest
    try { request = JSON.parse(data.toString()) }
    catch { socket.close(1003); return }
    if (!request || typeof request.requestId !== 'string') {
      socket.close(1003)
      return
    }

    let response: InvokeResponse
    try { response = await invoke(request) }
    catch (error) { response = { error: { message: error instanceof Error ? error.message : String(error) } } }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ requestId: request.requestId, response }))
  }
}
