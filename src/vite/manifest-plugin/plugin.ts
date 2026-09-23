import type { Plugin } from 'vite'
import type { PluginContext } from '#/context/context'
import { ManifestCollector } from './manifest-collector'

export function manifestPlugin(context: PluginContext): Plugin {
  const collector = new ManifestCollector(ids => context.collectRendererCandidates(ids), definitions => context.publishManifest(definitions))
  let releaseSignals: (() => void) | undefined
  return {
    name: 'electron-ipc-invoke:renderer-manifest',
    apply: 'build',
    enforce: 'pre',
    applyToEnvironment(environment) { return environment.name === 'client' },
    options: {
      order: 'post',
      handler(input) { collector.configure(input) },
    },
    buildStart(input) {
      collector.begin(input)
      if (this.meta.watchMode) releaseSignals ??= context.buildSignals.open()
      for (const file of context.buildSignals.files('renderer')) this.addWatchFile(file)
    },
    watchChange(id) {
      if (context.buildSignals.isSignal(id)) return
      collector.invalidate()
      if (collector.count > 1) context.buildSignals.notify('renderer')
    },
    closeWatcher() {
      releaseSignals?.()
      releaseSignals = undefined
    },
  }
}
