import { createIpcRuntime } from './ipc-runtime'
import type { IpcRuntime } from './ipc-runtime'
import type { DevConnectionInfo } from './protocol'

let runtimePromise: Promise<IpcRuntime> | undefined

/** Initialize the process-wide IPC runtime once. */
export function initRuntime(connection: DevConnectionInfo): Promise<IpcRuntime> {
  return runtimePromise ??= createIpcRuntime(connection)
}

/** Return the shared instance after initRuntime has started, including after close. */
export function getRuntime(): Promise<IpcRuntime> {
  if (!runtimePromise) return Promise.reject(new Error('IPC development runtime is not initialized'))
  return runtimePromise
}
