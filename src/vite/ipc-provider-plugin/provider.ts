import { normalizePath } from 'vite'
import type {
  DevEnvironment,
  EnvironmentModuleNode,
  FSWatcher,
  HotUpdateOptions,
  Rolldown,
} from 'vite'
import type { DefinitionTarget } from '#/compiler/types'
import { IPC_IMPLEMENTATION_QUERY } from '#/constants'
import {
  IPC_IMPLEMENTATION_ID_REGEX,
  SOURCE_MODULE_FILTER,
} from '#/vite/constants'
import type { IpcRegistry } from '#/vite/ipc-plugin/ipc-registry'
import { ipcDefinitionId } from '#/vite/ipc-plugin/module-id'

/** IPC metadata and authorization within the application's main environment. */
export class IpcProvider {
  private readonly unresolvedImports = new Map<
    string,
    { source: string; importer: string }
  >()
  private readonly definitionErrors = new Map<string, Error>()
  private updateQueue = Promise.resolve()
  private unsubscribe?: () => void

  constructor(
    private readonly environment: DevEnvironment,
    private readonly registry: IpcRegistry,
  ) {}

  init(watcher: FSWatcher) {
    this.unsubscribe ??= this.registry.subscribeDiscovery((file) =>
      watcher.add(file),
    )
  }

  async close() {
    this.unsubscribe?.()
    await this.updateQueue
  }

  async resolveImport(
    source: string,
    importer: string,
    resolve: () => Promise<Rolldown.PartialResolvedId | null>,
  ) {
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

  clearUnresolvedImports(file: string) {
    // A source edit replaces the imports of all its module variants.
    const source = normalizePath(file.split('?')[0])
    for (const [key, request] of this.unresolvedImports) {
      if (normalizePath(request.importer.split('?')[0]) === source)
        this.unresolvedImports.delete(key)
    }
  }

  async validate(target: DefinitionTarget) {
    for (;;) {
      const work = this.updateQueue
      await work
      if (work !== this.updateQueue) continue
      this.registry.lookup(target)
      const error = this.definitionErrors.get(target.moduleKey)
      if (error) throw error
      return
    }
  }

  hotUpdate(context: HotUpdateOptions) {
    // Recovery also resolves imports asynchronously, so it belongs in the same
    // queue that module requests wait for before reading the graph or registry.
    const work = this.updateQueue.then(() => this.applyUpdate(context))
    this.updateQueue = work.then(
      () => {},
      () => {},
    )
    return work
  }

  private async applyUpdate(context: HotUpdateOptions) {
    const recovered =
      context.type === 'create'
        ? await this.recoverImports()
        : new Set<string>()
    const modules = new Set(context.modules)
    for (const source of recovered) {
      const importer = this.environment.moduleGraph.getModuleById(source)
      if (importer) modules.add(importer)
    }
    // Definition edits also matter before their implementations enter the main graph.
    const affected = this.affectedDefinitions(
      [context.file, ...recovered],
      modules,
    )
    if (!affected.size) return

    const implementations = new Set<EnvironmentModuleNode>()
    // Preserve every calling proxy variant until its export contract changes.
    for (const node of modules) {
      const id = node.id
      if (
        id &&
        affected.has(ipcDefinitionId(id)) &&
        !IPC_IMPLEMENTATION_ID_REGEX.test(id) &&
        !SOURCE_MODULE_FILTER.exclude.some((pattern) => pattern.test(id))
      )
        modules.delete(node)
    }
    for (const moduleKey of affected) {
      const implementation = this.environment.moduleGraph.getModuleById(
        `${moduleKey}?${IPC_IMPLEMENTATION_QUERY}`,
      )
      if (implementation) implementations.add(implementation)
    }
    for (const node of new Set([...modules, ...implementations]))
      this.environment.moduleGraph.invalidateModule(node)
    for (const moduleKey of affected) {
      if (
        context.type === 'delete' &&
        moduleKey === normalizePath(context.file)
      ) {
        this.registry.invalidate(moduleKey)
        this.definitionErrors.delete(moduleKey)
      } else {
        await this.refreshDefinition(moduleKey)
      }
    }
    return [...modules]
  }

  private async recoverImports() {
    const recovered = new Set<string>()
    // An unresolved import has no graph edge for Vite's importer traversal.
    for (const [key, request] of this.unresolvedImports) {
      try {
        const resolved = await this.environment.pluginContainer.resolveId(
          request.source,
          request.importer,
        )
        if (!resolved) continue
        this.unresolvedImports.delete(key)
        recovered.add(request.importer)
      } catch {
        /* Keep the failed request until its dependency exists. */
      }
    }
    return recovered
  }

  private affectedDefinitions(
    files: Iterable<string>,
    modules: Iterable<EnvironmentModuleNode>,
  ): Set<string> {
    const affected = new Set<string>()
    for (const file of files) {
      const moduleKey = normalizePath(ipcDefinitionId(file))
      if (this.registry.isDiscovered(moduleKey)) affected.add(moduleKey)
    }
    const visited = new Set<EnvironmentModuleNode>()
    const queue = [...modules]
    for (const node of queue) {
      if (visited.has(node)) continue
      visited.add(node)
      const moduleKey = node.id && ipcDefinitionId(node.id)
      if (moduleKey && this.registry.isDiscovered(moduleKey))
        affected.add(moduleKey)
      for (const importer of node.importers) queue.push(importer)
    }
    return affected
  }

  private async refreshDefinition(moduleKey: string) {
    try {
      // Re-run application transforms without evaluating the implementation.
      if (
        !(await this.environment.transformRequest(
          `${moduleKey}?${IPC_IMPLEMENTATION_QUERY}`,
        ))
      ) {
        throw new Error(`IPC definition ${moduleKey} is unavailable`)
      }
      this.definitionErrors.delete(moduleKey)
    } catch (error) {
      this.definitionErrors.set(
        moduleKey,
        error instanceof Error ? error : new Error(String(error)),
      )
    }
  }
}
