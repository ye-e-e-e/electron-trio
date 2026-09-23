import type { Caller } from '#/compiler/types'

/** Encountered definitions and caller sources shared by the development plugins. */
export class DefinitionSources {
  private readonly modules = new Map<string, Set<Caller>>()
  private readonly watched = new Set<string>()
  private readonly listeners = new Set<(moduleKey: string) => void>()

  track(moduleKey: string, caller: Caller) {
    const callers = this.modules.get(moduleKey) ?? new Set<Caller>()
    callers.add(caller)
    this.modules.set(moduleKey, callers)
    this.watch(moduleKey)
  }

  watch(moduleKey: string) {
    if (this.watched.has(moduleKey)) return
    this.watched.add(moduleKey)
    for (const listener of this.listeners) listener(moduleKey)
  }

  keys() { return this.modules.keys() }
  has(moduleKey: string) { return this.modules.has(moduleKey) }
  callers(moduleKey: string): ReadonlySet<Caller> { return this.modules.get(moduleKey) ?? new Set() }

  setActive(caller: Caller, moduleKeys: Iterable<string>) {
    const active = new Set(moduleKeys)
    for (const [key, callers] of this.modules) {
      if (active.has(key)) callers.add(caller)
      else callers.delete(caller)
    }
  }

  subscribe(listener: (moduleKey: string) => void) {
    this.listeners.add(listener)
    for (const key of this.watched) listener(key)
    return () => { this.listeners.delete(listener) }
  }
}
