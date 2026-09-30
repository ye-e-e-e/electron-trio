import type { HotPayload } from 'vite'
import type {
  ModuleRunnerTransport,
  ModuleRunnerTransportHandlers,
} from 'vite/module-runner'
import type { DefinitionTarget } from '#/compiler/types'
import { VALIDATE_REQUEST, VALIDATE_RESPONSE } from './protocol'
import type { ElectronProcessMessage } from './protocol'

/** Child-side runner transport and validation requests over process IPC. */
export function createConnection(
  channel: Pick<
    NodeJS.Process,
    'on' | 'once' | 'off' | 'send' | 'connected'
  > = process,
) {
  let handlers: ModuleRunnerTransportHandlers | undefined
  let sequence = 0
  const pending = new Map<
    number,
    {
      resolve(): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  function send(payload: HotPayload) {
    if (!channel.connected)
      throw new Error('Electron development connection is closed')
    channel.send!(
      { type: 'runner:message', payload } satisfies ElectronProcessMessage,
      (error) => {
        if (error) disconnect()
      },
    )
  }
  function onMessage(message: unknown) {
    const data = message as ElectronProcessMessage | null
    if (data?.type !== 'runner:message' || !data.payload) return
    const payload = data.payload
    if (payload.type === 'custom' && payload.event === VALIDATE_RESPONSE) {
      const request = pending.get(payload.data.id)
      if (!request) return
      pending.delete(payload.data.id)
      clearTimeout(request.timer)
      if (payload.data.error) request.reject(new Error(payload.data.error))
      else request.resolve()
    } else handlers?.onMessage(payload)
  }
  function disconnect() {
    channel.off('message', onMessage)
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('Electron development connection is closed'))
    }
    pending.clear()
    handlers?.onDisconnection()
    handlers = undefined
  }
  const transport: ModuleRunnerTransport = {
    connect(callbacks) {
      handlers = callbacks
      channel.on('message', onMessage)
      channel.once('disconnect', disconnect)
      channel.send!(
        { type: 'runner:connected' } satisfies ElectronProcessMessage,
        (error) => {
          if (error) disconnect()
        },
      )
    },
    send,
    disconnect() {
      channel.off('disconnect', disconnect)
      disconnect()
    },
  }
  return {
    transport,
    validate(target: DefinitionTarget) {
      const id = ++sequence
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('IPC target validation timed out'))
        }, 15_000)
        pending.set(id, { resolve, reject, timer })
        try {
          send({
            type: 'custom',
            event: VALIDATE_REQUEST,
            data: { id, target },
          })
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        }
      })
    },
  }
}
