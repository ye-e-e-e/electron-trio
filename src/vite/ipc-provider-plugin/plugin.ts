import { builtinModules } from 'node:module'
import type { Plugin } from 'vite'
import type { PluginContext } from '#/context/context'
import { IpcEnvironment } from './environment'

const IPC_ENVIRONMENT_NAME = 'ipc_invoke'

/** Provide IPC implementation modules through Vite's ipc_invoke environment. */
export function ipcProviderPlugin(context: PluginContext): Plugin {
  return {
    name: 'electron-ipc-invoke:provider',
    apply: 'serve',
    enforce: 'pre',
    config() {
      return {
        environments: {
          [IPC_ENVIRONMENT_NAME]: {
            consumer: 'server',
            keepProcessEnv: true,
            resolve: { builtins: [...builtinModules, /^node:/, 'electron'], external: ['electron'] },
            dev: {
              moduleRunnerTransform: true,
              async createEnvironment(name, config) {
                const environment = new IpcEnvironment(name, config, context.registry, context.sources)
                context.devConnection = environment.connection
                await environment.connection
                return environment
              },
            },
          },
        },
      }
    },
    applyToEnvironment(environment) { return environment.name === IPC_ENVIRONMENT_NAME },
    async resolveId(source, importer, options) {
      if (!importer || source.startsWith('\0')) return
      return (this.environment as IpcEnvironment).resolveImport(source, importer,
        () => this.resolve(source, importer, { ...options, skipSelf: true }))
    },
    transform(_code, id) {
      (this.environment as IpcEnvironment).clearUnresolvedImports(id)
    },
    hotUpdate(context) { return (this.environment as IpcEnvironment).hotUpdate(context) },
  }
}
