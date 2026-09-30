import { exactRegex } from '@rolldown/pluginutils'
import MagicString from 'magic-string'
import type { Plugin } from 'vite'
import type { DefinitionRecord, ModuleAnalysis } from '#/compiler/types'
import { SOURCE_MODULE_FILTER } from '#/vite/constants'
import type { IpcContext } from '#/vite/ipc-plugin/context'
import { ipcDefinitionId } from '#/vite/ipc-plugin/module-id'
import { rendererModule } from './renderer-module'

const IPC_RENDERER_MODULE = 'virtual:electron-trio:ipc-renderer'
const RESOLVED_IPC_RENDERER_MODULE = '\0' + IPC_RENDERER_MODULE

export function ipcRendererPlugin(context: IpcContext): Plugin {
  // Compare against the renderer's last proxy, independently of runner updates.
  const signatures = new Map<string, string | undefined>()
  let updateQueue = Promise.resolve()
  return {
    name: 'electron-trio:ipc-renderer',
    enforce: 'pre',
    applyToEnvironment(environment) {
      return environment.name === 'client'
    },
    resolveId: {
      filter: { id: exactRegex(IPC_RENDERER_MODULE) },
      handler() {
        return RESOLVED_IPC_RENDERER_MODULE
      },
    },
    load: {
      filter: { id: exactRegex(RESOLVED_IPC_RENDERER_MODULE) },
      handler() {
        return rendererModule(context.bridgeName)
      },
    },
    transform: {
      filter: { id: SOURCE_MODULE_FILTER },
      async handler(code, id) {
        const dev = this.environment.config.command === 'serve'
        const moduleKey = ipcDefinitionId(id)
        const analysis = await context.registry.register(
          code,
          moduleKey,
          'renderer',
          {
            deferConflicts: !dev,
          },
        )
        if (analysis.kind !== 'definition') return
        if (dev) signatures.set(id, exportSignature(analysis))
        return definitionModule(analysis.definitions, id, dev)
      },
    },
    hotUpdate(update) {
      const work = updateQueue.then(async () => {
        const affected = [...signatures.keys()].filter(
          (id) => ipcDefinitionId(id) === update.file,
        )
        const modules = new Set(update.modules)
        for (const id of affected) {
          const moduleKey = ipcDefinitionId(id)
          const previous = signatures.get(id)
          // A failed update must let Vite propagate the next successful repair.
          signatures.set(id, undefined)
          const node = this.environment.moduleGraph.getModuleById(id)
          if (update.type === 'delete') {
            context.registry.invalidate(moduleKey)
          } else {
            if (node) this.environment.moduleGraph.invalidateModule(node)
            await this.environment.transformRequest(id)
            const analysis = context.registry.read(moduleKey)
            if (analysis?.kind === 'definition') {
              const next = exportSignature(analysis)
              signatures.set(id, next)
              if (previous === next) {
                if (node) modules.delete(node)
                continue
              }
            }
          }
          if (node) modules.add(node)
        }
        return [...modules]
      })
      updateQueue = work.then(
        () => {},
        () => {},
      )
      return work
    },
  }
}

function exportSignature(analysis: ModuleAnalysis) {
  return JSON.stringify(
    analysis.kind === 'definition'
      ? analysis.definitions.map(({ exportName }) => exportName)
      : [],
  )
}

function definitionModule(
  definitions: readonly DefinitionRecord[],
  file: string,
  dev = false,
) {
  const factory = dev ? 'createDevRendererInvoker' : 'createRendererInvoker'
  let local = '__ipcInvoke'
  while (definitions.some(({ exportName }) => exportName === local))
    local += '_'
  const code =
    `import { ${factory} as ${local} } from ${JSON.stringify(IPC_RENDERER_MODULE)};\n` +
    definitions
      .map(
        ({ moduleKey, exportName, channel }) =>
          `export const ${exportName} = /*#__PURE__*/ ${local}(${(dev ? [moduleKey, exportName] : [channel]).map((value) => JSON.stringify(value)).join(', ')});`,
      )
      .join('\n')
  // Never map proxies to the original main implementation or include its source.
  const output = new MagicString(code)
  return {
    code,
    map: output.generateMap({
      source: file + '?ipc-proxy',
      includeContent: true,
      hires: true,
    }),
  }
}
