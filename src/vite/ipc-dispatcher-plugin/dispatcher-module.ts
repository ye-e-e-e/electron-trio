import type { IpcDispatcher } from '#/runtime/ipc-dispatcher'

export interface IpcDispatcherModule {
  setDispatcher(dispatcher: IpcDispatcher): void
  getDispatcher(): IpcDispatcher
}

/** Shared access to the dispatcher injected by the native bootstrap. */
export function ipcDispatcherModule(): string {
  return `let dispatcher;

export function setDispatcher(value) {
  if (dispatcher && dispatcher !== value) throw new Error('IPC dispatcher is already initialized');
  dispatcher = value;
}

export function getDispatcher() {
  if (!dispatcher) throw new Error('IPC dispatcher is not initialized');
  return dispatcher;
}`
}
