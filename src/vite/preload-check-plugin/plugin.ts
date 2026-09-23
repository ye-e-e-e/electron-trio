import type { Plugin } from 'vite'
import { checkSourceContract, isSourceModule } from '#/compiler/source-contract'
import type { PluginContext } from '#/context/context'
import { analysisHost } from '#/vite/analysis-host'

export function preloadCheckPlugin(context: PluginContext): Plugin {
  return {
    name: 'electron-ipc-invoke:preload-check',
    enforce: 'pre',
    async transform(code, id) {
      if (!isSourceModule(id)) return
      const host = analysisHost(this.resolve.bind(this), file => this.addWatchFile(file))
      await checkSourceContract(context.registry, code, id, host)
      if ((await context.registry.analyze(code, id, host)).kind === 'definition') {
        this.error('Do not import IPC implementation modules into preload; its bridge is generated automatically')
      }
    },
  }
}
