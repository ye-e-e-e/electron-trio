import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type {
  HotChannel,
  HotChannelClient,
  HotChannelListener,
  HotPayload,
} from 'vite'
import type { ElectronProcessMessage } from '#/runtime/protocol'

/** Vite's module RPC and HMR share the private parent/child channel. */
export function createElectronHotChannel(onFullReload: () => void) {
  const events = new EventEmitter()
  let child: ChildProcess | undefined
  const send = (target: ChildProcess, payload: HotPayload) => {
    if (target.connected)
      target.send(
        { type: 'runner:message', payload } satisfies ElectronProcessMessage,
        () => {},
      )
  }
  return {
    skipFsCheck: true,
    send(payload) {
      if (payload.type === 'full-reload') onFullReload()
      else if (child) send(child, payload)
    },
    on(event: string, listener: HotChannelListener) {
      events.on(event, listener)
    },
    off(event, listener) {
      events.off(event, listener as (...args: unknown[]) => void)
    },
    close() {
      events.removeAllListeners()
      child = undefined
    },
    api: {
      connect(process: ChildProcess) {
        child = process
        const client: HotChannelClient = {
          send: (payload) => send(process, payload),
        }
        process.on('message', (message) => {
          const data = message as ElectronProcessMessage | null
          if (data?.type === 'runner:connected')
            events.emit('vite:client:connect', undefined, client)
          else if (
            data?.type === 'runner:message' &&
            data.payload?.type === 'custom'
          ) {
            events.emit(data.payload.event, data.payload.data, client)
          }
        })
        process.once('exit', () => {
          events.emit('vite:client:disconnect', undefined, client)
          if (child === process) child = undefined
        })
      },
    },
  } satisfies HotChannel<{ connect(process: ChildProcess): void }>
}
