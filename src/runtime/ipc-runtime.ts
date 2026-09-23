import type { IpcMainInvokeEvent } from 'electron'
import { isAbsolute } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ModuleRunner } from 'vite/module-runner'
import type { FetchResult } from 'vite/module-runner'
import type { HotPayload } from 'vite'
import WebSocket from 'ws'
import { HANDLER_KEY } from '#/constants'
import type { DefinitionTarget } from '#/compiler/types'
import type { DevConnectionInfo, InvokeResponse, ProviderMessage } from './protocol'

export interface IpcRuntime {
  invoke(target: DefinitionTarget, event: IpcMainInvokeEvent | undefined, input: unknown): Promise<unknown>
  close(): Promise<void>
}

const DEV_TIMEOUT_MS = 15_000

/** One IPC execution instance, including its connection, module cache, and cleanup. */
export async function createIpcRuntime(connection: DevConnectionInfo): Promise<IpcRuntime> {
  const socket = new WebSocket(connection.url, { headers: { authorization: `Bearer ${connection.token}` } })
  let sequence = 0
  let terminalError: Error | undefined
  const requests = new Map<string, { resolve(value: InvokeResponse): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const activeCalls = new Set<Promise<unknown>>()
  const executingHandler = new AsyncLocalStorage<boolean>()
  let loadQueue = Promise.resolve()
  let loadingTarget: DefinitionTarget | undefined
  let closePromise: Promise<void> | undefined

  function fail(error: Error) {
    terminalError ??= error
    for (const request of requests.values()) {
      clearTimeout(request.timer)
      request.reject(terminalError)
    }
    requests.clear()
  }

  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('IPC development connection timed out'))
      socket.terminate()
    }, DEV_TIMEOUT_MS)
    socket.once('open', () => { clearTimeout(timer); resolve() })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
    socket.once('close', () => { clearTimeout(timer); reject(new Error('IPC development connection closed')) })
  })
  socket.on('error', fail)
  socket.on('close', () => {
    fail(new Error('IPC development connection closed'))
    void close().catch(error => console.error(error))
  })
  socket.on('message', raw => {
    let message: ProviderMessage
    try { message = JSON.parse(raw.toString()) }
    catch { fail(new Error('Invalid IPC development response')); return }
    const pending = requests.get(message.requestId)
    if (!pending) return
    requests.delete(message.requestId)
    clearTimeout(pending.timer)
    pending.resolve(message.response)
  })

  async function request(payload: HotPayload): Promise<InvokeResponse> {
    await opened
    if (terminalError) throw terminalError
    const target = payload.type === 'custom' && payload.data?.name === 'fetchModule' && !payload.data.data[1]
      ? loadingTarget : undefined
    const requestId = String(++sequence)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(requestId)
        reject(new Error('IPC development module request timed out'))
      }, DEV_TIMEOUT_MS)
      requests.set(requestId, { resolve, reject, timer })
      socket.send(JSON.stringify({ requestId, payload, target }), error => {
        if (!error) return
        requests.delete(requestId)
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  const runner = new ModuleRunner({
    hmr: false,
    transport: {
      disconnect() { socket.close() },
      async invoke(payload) {
        // A running handler retains its already-loaded dependencies until the
        // next invocation. Waiting for that handler here would wait on itself.
        if (executingHandler.getStore() && payload.type === 'custom' && payload.data.name === 'fetchModule') {
          const [, importer, options] = payload.data.data
          if (importer && options?.cached) return { result: { cache: true } }
        }
        const response = await request(payload)
        const result = 'result' in response ? response.result as FetchResult : undefined
        if (result && 'invalidate' in result && result.invalidate) {
          const previous = runner.evaluatedModules.getModuleById(result.id)
          if (previous?.promise) {
            await Promise.allSettled(activeCalls)
            // Refresh dirty dependencies and their importers together.
            const modules = new Set([result.id, ...response.invalidated ?? []])
            for (const id of modules) {
              const module = runner.evaluatedModules.getModuleById(id)
              if (module) runner.evaluatedModules.invalidateModule(module)
            }
          }
        }
        if (terminalError) throw terminalError
        return response
      },
    },
  })

  try { await opened }
  catch (error) { await close(); throw error }
  return {
    async invoke(target, event, input) {
      if (!isAbsolute(target.moduleKey) || !target.exportName || (target.caller !== 'main' && target.caller !== 'renderer')) {
        throw new TypeError('Invalid IPC invocation target')
      }
      // Serialize imports while allowing handlers to run concurrently.
      const prepared = loadQueue.then(async () => {
        if (terminalError) throw terminalError
        loadingTarget = target
        try {
          const exports = await executingHandler.run(false, () => runner.import<Record<string, unknown>>(target.moduleKey))
          if (terminalError) throw terminalError
          const handler = exports[target.exportName] as { [key: symbol]: unknown } | undefined
          const execute = handler?.[Symbol.for(HANDLER_KEY)]
          if (typeof execute !== 'function') throw new Error(`IPC definition ${target.moduleKey}:${target.exportName} is unavailable`)
          const call = Promise.resolve().then(() => executingHandler.run(true, () => execute(event, input)))
          activeCalls.add(call)
          void call.then(() => activeCalls.delete(call), () => activeCalls.delete(call))
          return { call }
        } finally { loadingTarget = undefined }
      })
      loadQueue = prepared.then(() => {}, () => {})
      return (await prepared).call
    },
    close,
  }

  function close() {
    return closePromise ??= (async () => {
      fail(new Error('IPC development runtime closed'))
      await loadQueue
      await Promise.allSettled(activeCalls)
      await runner.close()
    })()
  }
}
