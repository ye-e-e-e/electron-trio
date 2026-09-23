import fs from 'node:fs/promises'
import MagicString from 'magic-string'
import type { Plugin } from 'vite'
import type { DefinitionRecord, ModuleAnalysis } from '#/compiler/types'
import type { PluginContext } from '#/context/context'
import { checkSourceContract, isSourceModule } from '#/compiler/source-contract'
import { analysisHost } from '#/vite/analysis-host'
import { rendererModule } from './renderer-module'

const RENDERER_MODULE = 'virtual:electron-ipc-invoke:renderer'
const RESOLVED_RENDERER_MODULE = '\0' + RENDERER_MODULE

export function rendererProxyPlugin(context: PluginContext): Plugin {
  // Compare against the renderer's last proxy, independently of runner updates.
  const signatures = new Map<string, string>()
  let updateQueue = Promise.resolve()
  return {
    name: 'electron-ipc-invoke:renderer-proxy',
    enforce: 'pre',
    applyToEnvironment(environment) { return environment.name === 'client' },
    resolveId(id) {
      if (id === RENDERER_MODULE) return RESOLVED_RENDERER_MODULE
    },
    load(id) {
      if (id === RESOLVED_RENDERER_MODULE) return rendererModule(context.bridgeName)
    },
    async transform(code, id) {
      if (!isSourceModule(id)) return
      const dev = this.environment.config.command === 'serve'
      const host = analysisHost(this.resolve.bind(this), file => dev ? context.sources.watch(file) : this.addWatchFile(file))
      await checkSourceContract(context.registry, code, id, host)
      const analysis = await context.registry.register(code, id, 'renderer', { deferConflicts: !dev, host })
      if (analysis.kind !== 'definition') return
      if (dev) {
        signatures.set(id, exportSignature(analysis))
        context.sources.track(id, 'renderer')
      }
      return definitionModule(analysis.definitions, id, dev)
    },
    hotUpdate(update) {
      const work = updateQueue.then(async () => {
        const affected = new Set([update.file, ...context.registry.affected(update.file)])
        const modules = new Set(update.modules)
        const host = analysisHost((source, importer, options) => this.environment.pluginContainer.resolveId(source, importer, options), file => context.sources.watch(file))
        for (const id of affected) {
          if (!signatures.has(id) && !context.registry.callers(id).has('renderer')) continue
          const previous = signatures.get(id)
          // A failed update must let Vite propagate the next successful repair.
          signatures.delete(id)
          const node = this.environment.moduleGraph.getModuleById(id)
          if (id === update.file && update.type === 'delete') {
            context.registry.remove(id, 'renderer')
          } else {
            const code = id === update.file ? await update.read() : await fs.readFile(id.split('?')[0], 'utf8')
            const analysis = await context.registry.register(code, id, 'renderer', { host })
            if (analysis.kind === 'definition') {
              context.sources.track(id, 'renderer')
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
      updateQueue = work.then(() => {}, () => {})
      return work
    },
  }
}

function exportSignature(analysis: ModuleAnalysis) {
  return JSON.stringify(analysis.kind === 'definition' ? analysis.definitions.map(({ exportName }) => exportName) : [])
}

function definitionModule(definitions: readonly DefinitionRecord[], file: string, dev = false) {
  const factory = dev ? 'createDevRendererInvoker' : 'createRendererInvoker'
  let local = '__ipcInvoke'
  while (definitions.some(({ exportName }) => exportName === local)) local += '_'
  const code = `import { ${factory} as ${local} } from ${JSON.stringify(RENDERER_MODULE)};\n` + definitions.map(({ moduleKey, exportName, channel }) =>
    `export const ${exportName} = /*#__PURE__*/ ${local}(${(dev ? [moduleKey, exportName] : [channel]).map(value => JSON.stringify(value)).join(', ')});`).join('\n')
  // Never map proxies to the original main implementation or include its source.
  const output = new MagicString(code)
  return { code, map: output.generateMap({ source: file + '?ipc-proxy', includeContent: true, hires: true }) }
}
