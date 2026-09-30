import MagicString from 'magic-string'
import type { Plugin } from 'vite'
import type { DefinitionRecord } from '#/compiler/types'
import {
  IPC_IMPLEMENTATION_ID_REGEX,
  MAIN_ENVIRONMENT,
  SOURCE_MODULE_FILTER,
} from '#/vite/constants'
import { IPC_DISPATCHER_MODULE } from '#/vite/ipc-dispatcher-plugin/constants'
import type { IpcContext } from '#/vite/ipc-plugin/context'
import { ipcDefinitionId } from '#/vite/ipc-plugin/module-id'

export function ipcMainPlugin(context: IpcContext): Plugin {
  const signatures = new Map<string, string>()
  return {
    name: 'electron-start:ipc-main',
    apply: 'serve',
    applyToEnvironment: (environment) => environment.name === MAIN_ENVIRONMENT,
    enforce: 'pre',
    transform: {
      filter: {
        id: {
          ...SOURCE_MODULE_FILTER,
          exclude: [
            ...SOURCE_MODULE_FILTER.exclude,
            IPC_IMPLEMENTATION_ID_REGEX,
          ],
        },
      },
      async handler(code, id) {
        const moduleKey = ipcDefinitionId(id)
        const analysis = await context.registry.register(
          code,
          moduleKey,
          'main',
        )
        if (analysis.kind !== 'definition') return
        signatures.set(
          id,
          JSON.stringify(
            analysis.definitions.map((record) => record.exportName),
          ),
        )
        const output = new MagicString(mainCallerModule(analysis.definitions))
        return {
          code: output.toString(),
          map: output.generateMap({
            source: id + '?ipc-proxy',
            includeContent: true,
            hires: true,
          }),
        }
      },
    },
    hotUpdate: {
      order: 'post',
      handler(update) {
        const modules = new Set(update.modules)
        // The renderer and provider share a registry, so compare with the last
        // generated proxy rather than the registry's potentially newer contents.
        for (const [key, previous] of signatures) {
          const analysis = context.registry.read(ipcDefinitionId(key))
          const next = JSON.stringify(
            analysis?.kind === 'definition'
              ? analysis.definitions.map((record) => record.exportName)
              : [],
          )
          const proxy = this.environment.moduleGraph.getModuleById(key)
          if (previous === next) {
            if (proxy) modules.delete(proxy)
            continue
          }
          signatures.set(key, next)
          if (proxy) {
            this.environment.moduleGraph.invalidateModule(proxy)
            modules.add(proxy)
          }
        }
        return [...modules]
      },
    },
  }
}

function mainCallerModule(definitions: readonly DefinitionRecord[]) {
  let local = '__getDispatcher'
  while (definitions.some(({ exportName }) => exportName === local))
    local += '_'
  return (
    `import { getDispatcher as ${local} } from ${JSON.stringify(IPC_DISPATCHER_MODULE)};\n` +
    definitions
      .map(
        ({ moduleKey, exportName }) =>
          `export const ${exportName} = async input => ${local}().invoke(${JSON.stringify({ caller: 'main', moduleKey, exportName })}, undefined, input);`,
      )
      .join('\n')
  )
}
