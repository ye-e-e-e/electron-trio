import { analyzeIpcModule } from '#/compiler/ipc-analyzer'
import type {
  Caller,
  DefinitionTarget,
  DefinitionRecord,
  ModuleAnalysis,
  ParsedModule,
} from '#/compiler/types'

interface Entry {
  analysis?: ModuleAnalysis
  callers: Set<Caller>
  /** Retained when a previously registered IPC module becomes unavailable or ordinary. */
  discovered: boolean
}
interface RegisterOptions {
  deferConflicts?: boolean
}

/** On-demand metadata only. This class never reads or enumerates the filesystem. */
export class IpcRegistry {
  private readonly cache = new Map<string, ParsedModule & { code: string }>()
  private readonly entries = new Map<string, Entry>()
  private readonly failures = new Map<string, Error>()
  private readonly listeners = new Set<(moduleKey: string) => void>()

  async parse(code: string, id: string): Promise<ParsedModule> {
    const cached = this.cache.get(id)
    if (cached?.code === code) return cached
    const parsed = { code, ...(await analyzeIpcModule(code, id)) }
    this.cache.set(id, parsed)
    return parsed
  }

  async analyze(code: string, id: string): Promise<ModuleAnalysis> {
    return (await this.parse(code, id)).analysis
  }

  async register(
    code: string,
    id: string,
    caller: Caller,
    options: RegisterOptions = {},
  ): Promise<ModuleAnalysis> {
    let analysis: ModuleAnalysis
    try {
      analysis = await this.analyze(code, id)
    } catch (error) {
      this.failures.set(
        id,
        error instanceof Error ? error : new Error(String(error)),
      )
      throw error
    }
    return this.update(
      id,
      analysis,
      new Set(this.callers(id)).add(caller),
      options,
    )
  }

  update(
    id: string,
    analysis: ModuleAnalysis,
    callers: ReadonlySet<Caller> = this.callers(id),
    options: RegisterOptions = {},
  ): ModuleAnalysis {
    const previous = this.entries.get(id)
    const entry: Entry = {
      analysis,
      callers: new Set(callers),
      discovered: previous?.discovered ?? false,
    }
    this.entries.set(id, entry)
    this.failures.delete(id)
    try {
      if (!options.deferConflicts) this.validate()
    } catch (error) {
      if (previous) this.entries.set(id, previous)
      else this.entries.delete(id)
      this.failures.set(
        id,
        error instanceof Error ? error : new Error(String(error)),
      )
      throw error
    }
    this.discover(id, entry)
    return analysis
  }

  isDiscovered(id: string): boolean {
    return this.entries.get(id)?.discovered ?? false
  }

  subscribeDiscovery(listener: (moduleKey: string) => void): () => void {
    this.listeners.add(listener)
    for (const [id, entry] of this.entries) if (entry.discovered) listener(id)
    return () => {
      this.listeners.delete(listener)
    }
  }

  callers(id: string): ReadonlySet<Caller> {
    return new Set(this.entries.get(id)?.callers)
  }

  read(id: string): ModuleAnalysis | undefined {
    return this.failures.has(id) ? undefined : this.entries.get(id)?.analysis
  }

  /** Withdraw deleted content while retaining its discovery and callers. */
  invalidate(id: string): void {
    const entry = this.entries.get(id)
    this.failures.delete(id)
    if (entry) entry.analysis = undefined
  }

  remove(id: string, caller?: Caller): void {
    const entry = this.entries.get(id)
    if (!entry) {
      if (!caller) this.failures.delete(id)
      return
    }
    if (caller) entry.callers.delete(caller)
    else entry.callers.clear()
    if (!entry.callers.size) {
      this.entries.delete(id)
      this.failures.delete(id)
    }
  }

  definitions(caller?: Caller): DefinitionRecord[] {
    return [...this.entries].flatMap(([id, entry]) =>
      this.failures.has(id) ||
      !entry.callers.size ||
      (caller && !entry.callers.has(caller)) ||
      entry.analysis?.kind !== 'definition'
        ? []
        : [...entry.analysis.definitions],
    )
  }

  setActive(caller: Caller, moduleKeys: Iterable<string>): void {
    const active = new Set(moduleKeys)
    for (const [id, entry] of this.entries) {
      if (active.has(id)) entry.callers.add(caller)
      else entry.callers.delete(caller)
    }
    // Retain inactive metadata because a cached transform can become active again.
    for (const id of active)
      if (!this.entries.has(id)) {
        const cached = this.cache.get(id)
        if (cached)
          this.entries.set(id, {
            analysis: cached.analysis,
            callers: new Set([caller]),
            discovered: false,
          })
      }
    this.validate()
    for (const [id, entry] of this.entries) this.discover(id, entry)
  }

  lookup(target: DefinitionTarget): DefinitionRecord {
    const failure = this.failures.get(target.moduleKey)
    if (failure) throw failure
    const entry = this.entries.get(target.moduleKey)
    const definition =
      entry?.callers.has(target.caller) && entry.analysis?.kind === 'definition'
        ? entry.analysis.definitions.find(
            (record) => record.exportName === target.exportName,
          )
        : undefined
    if (definition) return definition
    throw new Error(
      `Unknown IPC export ${JSON.stringify(target.exportName)} in ${target.moduleKey} for ${target.caller}`,
    )
  }

  validate(): void {
    const channels = new Map<string, DefinitionRecord>()
    for (const record of this.definitions()) {
      const previous = channels.get(record.channel)
      if (previous)
        throw new Error(
          `Duplicate IPC channel ${JSON.stringify(record.channel)}: ${previous.moduleKey}:${previous.line} and ${record.moduleKey}:${record.line}`,
        )
      channels.set(record.channel, record)
    }
  }

  private discover(id: string, entry: Entry): void {
    if (
      entry.discovered ||
      !entry.callers.size ||
      entry.analysis?.kind !== 'definition'
    )
      return
    entry.discovered = true
    for (const listener of this.listeners) listener(id)
  }
}
