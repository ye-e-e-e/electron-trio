import type { Plugin } from 'vite'
import { PROXY, decodeChannel, definitionModule, proxyModule } from './generate.js'
import { RendererOutputs } from './selection.js'
import type { BuildSession } from './session.js'
import type { Snapshot } from './registry.js'

export function rendererPlugin(session: BuildSession): Plugin {
  const outputs = new RendererOutputs((channels) => session.publish(channels))
  let snapshot: Snapshot
  let watching: Promise<() => Promise<void>> | undefined
  let failed = false

  return {
    name: 'electron-ipc-invoke:renderer',
    enforce: 'pre',
    configResolved(config) { session.configure(config, 'renderer') },
    options: {
      order: 'post',
      handler(input) { if (session.command === 'build') outputs.configure(input) },
    },
    async buildStart(input) {
      if (session.command === 'build') {
        outputs.begin(input)
        if (this.meta.watchMode) await (watching ??= session.watch.open(true, outputs.invalidate))
      }
      session.watch.check()
      snapshot = session.definitions.refresh()
      session.watch.initialize(snapshot)
      for (const file of session.watch.files('renderer')) this.addWatchFile(file)
    },
    watchChange(id) {
      if (session.watch.isSignal(id)) return
      if (session.definitions.matches(id)) session.definitions.invalidate()
      outputs.invalidate()
      // Rolldown may watch formats separately. Rebuild every renderer output.
      if (outputs.count > 1) session.watch.notify('renderer')
    },
    resolveId(id) {
      if (id.startsWith(PROXY)) return { id, moduleSideEffects: false }
    },
    load(id) {
      if (id.startsWith(PROXY)) return proxyModule(decodeChannel(id.slice(PROXY.length)), session.bridgeName)
    },
    transform(code, id) {
      const file = id.split('?')[0]
      if (!session.definitions.matches(file)) {
        if (file.endsWith('.ipc.ts')) this.error(`IPC module is outside include or excluded: ${file}`)
        return
      }
      for (const dependency of session.watch.files('renderer')) this.addWatchFile(dependency)
      const current = session.command === 'serve' ? session.definitions.read() : snapshot
      return definitionModule(session.definitions.rendererHandlers(code, file, current), file)
    },
    configureServer(server) { server.watcher.add(session.definitions.watchRoots()) },
    hotUpdate(context) {
      if (!session.definitions.matches(context.file)) return
      const previous = snapshot?.files.get(context.file)?.handlers ?? []
      try {
        snapshot = session.watch.definitionsChanged()
        const next = snapshot.files.get(context.file)?.handlers ?? []
        const changed = previous.length !== next.length || previous.some((handler, i) => handler.name !== next[i].name || handler.channel !== next[i].channel)
        if (changed || failed) {
          const invalidated = new Set<typeof context.modules[number]>()
          for (const module of context.modules) this.environment.moduleGraph.invalidateModule(module, invalidated, context.timestamp, true)
          this.environment.hot.send({ type: 'full-reload' })
        }
        failed = false
        return []
      } catch (error) {
        failed = true
        throw error
      }
    },
    async closeWatcher() {
      await watching?.then((close) => close(), () => {})
      watching = undefined
    },
  }
}
