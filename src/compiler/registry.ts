import { analyzeModule } from './analyzer'
import type { AnalysisHost, Caller, DefinitionTarget, DefinitionRecord, ModuleAnalysis, ParsedModule } from './types'

interface Entry { analysis: ModuleAnalysis; callers: Set<Caller> }
interface RegisterOptions { deferConflicts?: boolean; host?: AnalysisHost }

/** On-demand metadata only. This class never reads or enumerates the filesystem. */
export class DefinitionRegistry {
  private readonly cache = new Map<string, ParsedModule & { code: string }>()
  private readonly entries = new Map<string, Entry>()
  private readonly failures = new Map<string, Error>()
  private readonly dependencies = new Map<string, Set<string>>()
  revision = 0

  async parse(code: string, id: string, host?: AnalysisHost): Promise<ParsedModule> {
    const cached = this.cache.get(id)
    if (!host && cached?.code === code && !this.dependencies.get(id)?.size) return cached
    const dependencies = new Set<string>()
    try {
      const parsed = { code, ...await analyzeModule(code, id, host && {
        async load(source, importer) {
          const loaded = await host.load(source, importer)
          if (loaded) dependencies.add(loaded.id)
          return loaded
        },
      }) }
      this.dependencies.set(id, dependencies)
      this.cache.set(id, parsed)
      return parsed
    } catch (error) {
      // Keep earlier dependencies so deleting and restoring a builder can recover.
      this.dependencies.set(id, new Set([...this.dependencies.get(id) ?? [], ...dependencies]))
      throw error
    }
  }

  async analyze(code: string, id: string, host?: AnalysisHost): Promise<ModuleAnalysis> {
    return (await this.parse(code, id, host)).analysis
  }

  async register(code: string, id: string, caller: Caller, options: RegisterOptions = {}): Promise<ModuleAnalysis> {
    let analysis: ModuleAnalysis
    try { analysis = await this.analyze(code, id, options.host) }
    catch (error) {
      this.failures.set(id, error instanceof Error ? error : new Error(String(error)))
      this.revision++
      throw error
    }
    return this.update(id, analysis, new Set(this.callers(id)).add(caller), options)
  }

  affected(file: string): string[] {
    return [...this.dependencies].filter(([id, dependencies]) =>
      id.split('?')[0] === file || [...dependencies].some(dependency => dependency.split('?')[0] === file))
      .map(([id]) => id)
  }

  update(id: string, analysis: ModuleAnalysis, callers: ReadonlySet<Caller> = this.callers(id), options: RegisterOptions = {}): ModuleAnalysis {
    const previous = this.entries.get(id)
    this.entries.set(id, { analysis, callers: new Set(callers) })
    this.failures.delete(id)
    try { if (!options.deferConflicts) this.validate() }
    catch (error) {
      if (previous) this.entries.set(id, previous)
      else this.entries.delete(id)
      this.failures.set(id, error instanceof Error ? error : new Error(String(error)))
      this.revision++
      throw error
    }
    this.revision++
    return analysis
  }

  callers(id: string): ReadonlySet<Caller> {
    return new Set(this.entries.get(id)?.callers)
  }

  read(id: string): ModuleAnalysis | undefined {
    return this.failures.has(id) ? undefined : this.entries.get(id)?.analysis
  }

  remove(id: string, caller?: Caller): void {
    const entry = this.entries.get(id)
    if (!entry) {
      if (!caller && this.failures.delete(id)) this.revision++
      return
    }
    if (caller) entry.callers.delete(caller)
    else entry.callers.clear()
    if (!entry.callers.size) {
      this.entries.delete(id)
      this.failures.delete(id)
    }
    this.revision++
  }

  definitions(caller?: Caller): DefinitionRecord[] {
    return [...this.entries].flatMap(([id, entry]) =>
      this.failures.has(id) || !entry.callers.size || (caller && !entry.callers.has(caller)) || entry.analysis.kind !== 'definition'
        ? [] : [...entry.analysis.definitions])
  }

  setActive(caller: Caller, moduleKeys: Iterable<string>): void {
    const active = new Set(moduleKeys)
    for (const [id, entry] of this.entries) {
      if (active.has(id)) entry.callers.add(caller)
      else entry.callers.delete(caller)
    }
    // Retain inactive metadata because a cached transform can become active again.
    for (const id of active) if (!this.entries.has(id)) {
      const cached = this.cache.get(id)
      if (cached) this.entries.set(id, { analysis: cached.analysis, callers: new Set([caller]) })
    }
    this.revision++
    this.validate()
  }

  lookup(target: DefinitionTarget): DefinitionRecord {
    const failure = this.failures.get(target.moduleKey)
    if (failure) throw failure
    const entry = this.entries.get(target.moduleKey)
    const definition = entry?.callers.has(target.caller) && entry.analysis.kind === 'definition'
      ? entry.analysis.definitions.find(record => record.exportName === target.exportName)
      : undefined
    if (definition) return definition
    throw new Error(`Unknown IPC export ${JSON.stringify(target.exportName)} in ${target.moduleKey} for ${target.caller}`)
  }

  validate(): void {
    const channels = new Map<string, DefinitionRecord>()
    for (const record of this.definitions()) {
      const previous = channels.get(record.channel)
      if (previous) throw new Error(`Duplicate IPC channel ${JSON.stringify(record.channel)}: ${previous.moduleKey}:${previous.line} and ${record.moduleKey}:${record.line}`)
      channels.set(record.channel, record)
    }
  }
}
