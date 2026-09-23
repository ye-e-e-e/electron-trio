import fs from 'node:fs/promises'
import { DevEnvironment, normalizePath } from 'vite'
import type { EnvironmentModuleNode, HotUpdateOptions, ResolvedConfig, Rolldown } from 'vite'
import type { InvokeResponse, ProviderRequest } from '#/runtime/protocol'
import type { DefinitionRegistry } from '#/compiler/registry'
import type { DefinitionSources } from '#/context/definition-sources'
import { analysisHost } from '#/vite/analysis-host'
import { createRpcServer } from './rpc-server'

/** Vite environment that serves validated IPC modules to the Electron runner. */
export class IpcEnvironment extends DevEnvironment {
  private readonly rpc = createRpcServer(request => this.invoke(request))
  private readonly unresolvedImports = new Map<string, { source: string; importer: string }>()
  private readonly definitionErrors = new Map<string, Error>()
  private updateQueue = Promise.resolve()
  private unsubscribe?: () => void
  readonly connection = this.rpc.ready

  constructor(name: string, config: ResolvedConfig, private readonly registry: DefinitionRegistry, private readonly sources: DefinitionSources) {
    super(name, config, { hot: false })
  }

  override async init(options?: Parameters<DevEnvironment['init']>[0]) {
    await super.init(options)
    const watcher = options?.watcher
    if (watcher) this.unsubscribe ??= this.sources.subscribe(file => watcher.add(file))
  }

  override async close() {
    this.unsubscribe?.()
    await this.rpc.close()
    await this.updateQueue
    await super.close()
  }

  async resolveImport(source: string, importer: string, resolve: () => Promise<Rolldown.PartialResolvedId | null>) {
    const key = JSON.stringify([source, importer])
    let resolved: Rolldown.PartialResolvedId | null = null
    try {
      resolved = await resolve()
      return resolved
    } finally {
      if (resolved) this.unresolvedImports.delete(key)
      else this.unresolvedImports.set(key, { source, importer })
    }
  }

  clearUnresolvedImports(importer: string) {
    for (const [key, request] of this.unresolvedImports) {
      if (request.importer === importer) this.unresolvedImports.delete(key)
    }
  }

  async invoke({ payload, target }: ProviderRequest): Promise<InvokeResponse> {
    if (payload.type !== 'custom' || payload.event !== 'vite:invoke') throw new Error('Invalid module request')
    const { name, data } = payload.data
    if (name !== 'fetchModule' && name !== 'getBuiltins') throw new Error('Unknown module request')
    for (;;) {
      const work = this.updateQueue
      await work
      if (work !== this.updateQueue) continue
      if (name === 'fetchModule' && !data[1]) {
        if (!target || target.moduleKey !== data[0]) throw new Error('Missing IPC invocation target')
        this.registry.lookup(target)
        const error = this.definitionErrors.get(target.moduleKey)
        if (error) throw error
      }
      // Include dirty dependencies/importers so lazy dynamic imports update
      // together with the definitions that use them.
      const invalidated = name === 'fetchModule'
        ? [...this.moduleGraph.idToModuleMap.values()].flatMap(node => !node.transformResult && node.id ? [node.id] : [])
        : []
      const response = await this.hot.handleInvoke(payload)
      if (work === this.updateQueue) return { ...response, invalidated }
      // An edit during transformation must be observed before returning executable code.
      if (name === 'fetchModule') data[2] = { ...data[2], cached: false }
    }
  }

  hotUpdate(context: HotUpdateOptions) {
    // Recovery also resolves imports asynchronously, so it belongs in the same
    // queue that module requests wait for before reading the graph or registry.
    const work = this.updateQueue.then(() => this.applyUpdate(context))
    this.updateQueue = work.then(() => {}, () => {})
    return work
  }

  private async applyUpdate(context: HotUpdateOptions) {
    const recovered = context.type === 'create' ? await this.recoverImports() : new Set<string>()
    const modules = new Set(context.modules)
    for (const source of recovered) {
      const importer = this.moduleGraph.getModuleById(source)
      if (importer) modules.add(importer)
    }
    // Static binding resolution can fail before the runner creates a module graph.
    const affected = this.affectedDefinitions([context.file, ...recovered], modules)
    if (!affected.size) return

    for (const node of modules) this.moduleGraph.invalidateModule(node)
    for (const moduleKey of affected) {
      const node = this.moduleGraph.getModuleById(moduleKey)
      if (node) this.moduleGraph.invalidateModule(node)
      await this.refreshDefinition(moduleKey)
    }
    // Leave transform caches invalid until the runner asks for the module.
    return []
  }

  private async recoverImports() {
    const recovered = new Set<string>()
    // An unresolved import has no graph edge for Vite's importer traversal.
    for (const [key, request] of this.unresolvedImports) {
      try {
        const resolved = await this.pluginContainer.resolveId(request.source, request.importer)
        if (!resolved) continue
        this.unresolvedImports.delete(key)
        recovered.add(request.importer)
      } catch { /* Keep the failed request until its dependency exists. */ }
    }
    return recovered
  }

  private affectedDefinitions(files: Iterable<string>, modules: Iterable<EnvironmentModuleNode>): Set<string> {
    const affected = new Set<string>()
    for (const file of files) {
      const normalized = normalizePath(file)
      for (const key of this.sources.keys()) if (key.split('?')[0] === normalized) affected.add(key)
      for (const key of this.registry.affected(normalized)) if (this.sources.has(key)) affected.add(key)
    }
    const visited = new Set<EnvironmentModuleNode>()
    const queue = [...modules]
    for (const node of queue) {
      if (visited.has(node)) continue
      visited.add(node)
      if (node.id && this.sources.has(node.id)) affected.add(node.id)
      for (const importer of node.importers) queue.push(importer)
    }
    return affected
  }

  private async refreshDefinition(moduleKey: string) {
    try {
      const code = await fs.readFile(moduleKey.split('?')[0], 'utf8')
      const host = analysisHost((source, importer, options) => this.pluginContainer.resolveId(source, importer, options), file => this.sources.watch(file))
      const analysis = await this.registry.analyze(code, moduleKey, host)
      const active = this.registry.callers(moduleKey)
      this.registry.update(moduleKey, analysis, active.size ? active : this.sources.callers(moduleKey))
      this.definitionErrors.delete(moduleKey)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.registry.remove(moduleKey)
      }
      this.definitionErrors.set(moduleKey, error instanceof Error ? error : new Error(String(error)))
    }
  }
}
