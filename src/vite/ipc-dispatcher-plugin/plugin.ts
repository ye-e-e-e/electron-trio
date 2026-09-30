import { exactRegex } from '@rolldown/pluginutils'
import type { Plugin } from 'vite'
import { MAIN_ENVIRONMENT } from '#/vite/constants'
import { IPC_DISPATCHER_MODULE } from './constants'
import { ipcDispatcherModule } from './dispatcher-module'

const RESOLVED_IPC_DISPATCHER_MODULE = '\0' + IPC_DISPATCHER_MODULE

export function ipcDispatcherPlugin(): Plugin {
  return {
    name: 'electron-start:ipc-dispatcher',
    apply: 'serve',
    applyToEnvironment: (environment) => environment.name === MAIN_ENVIRONMENT,
    resolveId: {
      filter: { id: exactRegex(IPC_DISPATCHER_MODULE) },
      handler() {
        return RESOLVED_IPC_DISPATCHER_MODULE
      },
    },
    load: {
      filter: { id: exactRegex(RESOLVED_IPC_DISPATCHER_MODULE) },
      handler() {
        return ipcDispatcherModule()
      },
    },
  }
}
