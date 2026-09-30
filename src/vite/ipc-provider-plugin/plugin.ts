import MagicString from 'magic-string'
import type { DevEnvironment, Plugin } from 'vite'
import { VALIDATE_REQUEST, VALIDATE_RESPONSE } from '#/runtime/protocol'
import {
  IPC_IMPLEMENTATION_ID_REGEX,
  MAIN_ENVIRONMENT,
  SOURCE_MODULE_FILTER,
} from '#/vite/constants'
import type { IpcContext } from '#/vite/ipc-plugin/context'
import { ipcDefinitionId } from '#/vite/ipc-plugin/module-id'
import { IpcProvider } from './provider'

/** Authorize IPC targets and give implementations an HMR boundary in the main graph. */
export function ipcProviderPlugin(context: IpcContext): Plugin {
  const providers = new WeakMap<DevEnvironment, IpcProvider>()
  return {
    name: 'electron-start:provider',
    apply: 'serve',
    perEnvironmentStartEndDuringDev: true,
    applyToEnvironment: (environment) => environment.name === MAIN_ENVIRONMENT,
    configureServer(server) {
      const environment = server.environments[MAIN_ENVIRONMENT]
      const provider = new IpcProvider(environment, context.registry)
      providers.set(environment, provider)
      provider.init(server.watcher)
      environment.hot.on(VALIDATE_REQUEST, async ({ id, target }, client) => {
        try {
          await provider.validate(target)
          client.send(VALIDATE_RESPONSE, { id })
        } catch (error) {
          client.send(VALIDATE_RESPONSE, {
            id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
    },
    async resolveId(source, importer, options) {
      if (!importer || source.startsWith('\0')) return
      return providers
        .get(this.environment as DevEnvironment)
        ?.resolveImport(source, importer, () =>
          this.resolve(source, importer, { ...options, skipSelf: true }),
        )
    },
    watchChange(id) {
      providers
        .get(this.environment as DevEnvironment)
        ?.clearUnresolvedImports(id)
    },
    transform: {
      filter: {
        id: {
          include: IPC_IMPLEMENTATION_ID_REGEX,
          exclude: SOURCE_MODULE_FILTER.exclude,
        },
      },
      async handler(code, id) {
        const moduleKey = ipcDefinitionId(id)
        const analysis = await context.registry.analyze(code, moduleKey)
        context.registry.update(moduleKey, analysis)
        if (analysis.kind !== 'definition') return
        const output = new MagicString(code)
        output.append('\nif (import.meta.hot) import.meta.hot.accept();\n')
        return {
          code: output.toString(),
          map: output.generateMap({
            source: id,
            includeContent: true,
            hires: true,
          }),
        }
      },
    },
    hotUpdate(update) {
      return providers.get(this.environment)?.hotUpdate(update)
    },
    async closeBundle() {
      await providers.get(this.environment as DevEnvironment)?.close()
    },
  }
}
