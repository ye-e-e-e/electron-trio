import { DefinitionRegistry } from '#/compiler/registry'
import type { DefinitionRecord } from '#/compiler/types'
import type { DevConnectionInfo } from '#/runtime/protocol'
import { BuildSignals } from './build-signals'
import { DefinitionSources } from './definition-sources'
import type { PluginContextOptions } from './types'

const DEFAULT_BRIDGE_NAME = '__ipc'

/** Shared by the independently installed renderer, main and preload plugins. */
export class PluginContext {
  readonly registry = new DefinitionRegistry()
  readonly buildSignals = new BuildSignals()
  readonly sources = new DefinitionSources()
  devConnection?: Promise<DevConnectionInfo>
  readonly bridgeName: string
  command?: 'serve' | 'build'
  private manifest?: readonly DefinitionRecord[]

  constructor(options: PluginContextOptions) {
    this.bridgeName = options.bridgeName ?? DEFAULT_BRIDGE_NAME
    if (!this.bridgeName.trim()) throw new Error('bridgeName must be non-empty')
  }

  collectRendererCandidates(moduleIds: Iterable<string>) {
    this.registry.setActive('renderer', moduleIds)
    return this.registry.definitions('renderer')
  }

  publishManifest(definitions: readonly DefinitionRecord[]) {
    const ordered = definitions.map(record => Object.freeze({ ...record })).sort((a, b) => a.channel.localeCompare(b.channel))
    const signature = (records: readonly DefinitionRecord[]) => JSON.stringify(records.map(({ channel, moduleKey, exportName }) => [channel, moduleKey, exportName]))
    if (this.manifest && signature(this.manifest) === signature(ordered)) return
    this.manifest = Object.freeze(ordered)
    this.buildSignals.notify('manifest')
  }

  requireManifest() {
    if (!this.manifest) throw new Error('Build renderer before main/preload using plugins from the same ipcInvoke() call')
    return this.manifest
  }
}
