import fs from 'node:fs/promises'
import type { Plugin } from 'vite'
import { DEV_RUNTIME_IMPORT } from '#/constants'
import type { DefinitionRecord } from '#/compiler/types'
import type { PluginContext } from '#/context/context'
import { isSourceModule } from '#/compiler/source-contract'
import { ANALYSIS_REQUEST, analysisHost } from '#/vite/analysis-host'
import { RESOLVED_MAIN_CALLER_PREFIX } from './constants'

export function mainProxyPlugin(context: PluginContext): Plugin {
  return {
    name: 'electron-ipc-invoke:main-proxy',
    enforce: 'pre',
    resolveId: {
      order: 'pre',
      async handler(id, importer, options) {
        if (context.command !== 'serve') return
        if (options.custom?.[ANALYSIS_REQUEST]) return
        if (id.startsWith(RESOLVED_MAIN_CALLER_PREFIX)) return id
        if (id.startsWith('\0')) return
        const resolved = await this.resolve(id, importer, { ...options, skipSelf: true })
        if (!resolved || resolved.external || !isSourceModule(resolved.id)) return
        let source: string
        try { source = await fs.readFile(resolved.id.split('?')[0], 'utf8') }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
          throw error
        }
        const host = analysisHost(this.resolve.bind(this), file => context.sources.watch(file))
        const analysis = await context.registry.register(source, resolved.id, 'main', { host })
        if (analysis.kind !== 'definition') return
        context.sources.track(resolved.id, 'main')
        return { id: RESOLVED_MAIN_CALLER_PREFIX + encodeURIComponent(resolved.id), moduleSideEffects: false }
      },
    },
    load(id) {
      if (context.command !== 'serve' || !id.startsWith(RESOLVED_MAIN_CALLER_PREFIX)) return
      const key = decodeURIComponent(id.slice(RESOLVED_MAIN_CALLER_PREFIX.length))
      const analysis = context.registry.read(key)
      if (analysis?.kind !== 'definition') this.error(`IPC definition ${key} is unavailable`)
      return mainCallerModule(analysis.definitions)
    },
    buildEnd(error) {
      if (error || context.command !== 'serve') return
      const active = [...this.getModuleIds()]
        .filter(id => id.startsWith(RESOLVED_MAIN_CALLER_PREFIX))
        .map(id => decodeURIComponent(id.slice(RESOLVED_MAIN_CALLER_PREFIX.length)))
      context.registry.setActive('main', active)
      context.sources.setActive('main', active)
    },
  }
}

function mainCallerModule(definitions: readonly DefinitionRecord[]) {
  let local = '__getRuntime'
  while (definitions.some(({ exportName }) => exportName === local)) local += '_'
  return `import { getRuntime as ${local} } from ${JSON.stringify(DEV_RUNTIME_IMPORT)};\n` + definitions.map(({ moduleKey, exportName }) =>
    `export const ${exportName} = async input => (await ${local}()).invoke(${JSON.stringify({ caller: 'main', moduleKey, exportName })}, undefined, input);`).join('\n')
}
