import type { Plugin } from 'vite'
import { ENTRY, injectEntry, mainModule, preloadModule } from './generate.js'
import type { BuildSession } from './session.js'
import type { Snapshot } from './registry.js'

export function hostPlugin(session: BuildSession, target: 'main' | 'preload'): Plugin {
  const entries = new Map<string, string>()
  const generated = new Set<string>()
  let snapshot: Snapshot
  let watching: Promise<() => Promise<void>> | undefined

  return {
    name: `electron-ipc-invoke:${target}`,
    enforce: 'pre',
    configResolved(config) { session.configure(config, target) },
    async buildStart(input) {
      if (!session.command) this.error('Initialize ipc.renderer() before starting main/preload builds')
      entries.clear()
      generated.clear()
      const entry = input.input
      const inputs = typeof entry === 'string' ? [entry] : Array.isArray(entry) ? entry : Object.values(entry ?? {})
      if (!inputs.length || (target === 'main' && inputs.length !== 1)) this.error(`IPC ${target} requires ${target === 'main' ? 'one' : 'at least one'} entry`)
      for (const [index, name] of inputs.entries()) {
        const resolved = await this.resolve(name, undefined, { isEntry: true })
        if (!resolved || resolved.external) this.error(`Cannot resolve IPC ${target} entry: ${name}`)
        if (session.definitions.matches(resolved.id.split('?')[0])) this.error('An IPC definition cannot also be a main/preload entry')
        // A module per entry keeps each sandboxed preload independently executable.
        const id = ENTRY + target + ':' + index
        entries.set(resolved.id, id)
        generated.add('\0' + id)
      }
      if (this.meta.watchMode) await (watching ??= session.watch.open(session.command === 'build'))
      session.watch.check()
      snapshot = session.definitions.refresh()
      session.watch.initialize(snapshot)
      for (const file of session.watch.files(target)) this.addWatchFile(file)
    },
    watchChange(id) {
      if (session.definitions.matches(id)) session.definitions.invalidate()
    },
    resolveId(id) {
      if (generated.has('\0' + id)) return { id: '\0' + id, moduleSideEffects: 'no-treeshake' }
    },
    load(id) {
      if (!generated.has(id)) return
      for (const file of session.watch.files(target)) this.addWatchFile(file)
      return ''
    },
    transform(code, id) {
      if (generated.has(id)) {
        const handlers = session.handlers(snapshot)
        return { code: target === 'main' ? mainModule(handlers) : preloadModule(handlers, session.bridgeName), map: null }
      }
      const injected = entries.get(id)
      if (injected) return injectEntry(code, id, injected)
      if (target === 'preload' && session.definitions.matches(id.split('?')[0])) {
        this.error('Do not import IPC implementation modules into preload; its bridge is generated automatically')
      }
    },
    async closeWatcher() {
      await watching?.then((close) => close(), () => {})
      watching = undefined
    },
  }
}
