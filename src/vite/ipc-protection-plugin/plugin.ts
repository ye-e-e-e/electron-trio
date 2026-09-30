import type { Plugin } from 'vite'
import { PRELOAD_ENVIRONMENT, SOURCE_MODULE_FILTER } from '#/vite/constants'
import type { IpcContext } from '#/vite/ipc-plugin/context'

export function ipcProtectionPlugin(context: IpcContext): Plugin {
  return {
    name: 'electron-start:ipc-protection',
    enforce: 'pre',
    applyToEnvironment: (environment) =>
      environment.name === PRELOAD_ENVIRONMENT,
    transform: {
      filter: { id: SOURCE_MODULE_FILTER },
      async handler(code, id) {
        if ((await context.registry.analyze(code, id)).kind === 'definition') {
          this.error(
            'Do not import IPC implementation modules into preload; its bridge is generated automatically',
          )
        }
      },
    },
  }
}
