import type { ResolvedConfig } from 'vite'
import { DefinitionRegistry } from './registry.js'
import type { Snapshot } from './registry.js'
import { BuildWatch } from './watch.js'
import type { IpcInvokeOptions, Target } from './options.js'

/** One application: a renderer build and its main/preload builds. */
export class BuildSession {
  readonly definitions: DefinitionRegistry
  readonly watch: BuildWatch
  readonly bridgeName: string
  command?: 'serve' | 'build'
  private channels?: ReadonlySet<string>

  constructor(private readonly options: IpcInvokeOptions) {
    this.bridgeName = options.bridgeName ?? '__ipc'
    if (!this.bridgeName.trim()) throw new Error('bridgeName must be non-empty')
    this.definitions = new DefinitionRegistry(options)
    this.watch = new BuildWatch(this.definitions)
  }

  configure(config: ResolvedConfig, target: Target) {
    this.definitions.configure(this.options.root ?? config.root)
    if (target === 'renderer') {
      if (this.command !== config.command) this.channels = undefined
      this.command = config.command
    }
  }

  publish(channels: ReadonlySet<string>) {
    const changed = !this.channels || channels.size !== this.channels.size || [...channels].some((channel) => !this.channels!.has(channel))
    this.channels = channels
    if (changed) this.watch.notify('channels')
  }

  handlers(snapshot: Snapshot) {
    if (this.command === 'serve') return [...snapshot.channels.values()]
    if (!this.channels) throw new Error('Build renderer before main/preload using plugins from the same ipcInvoke() call')
    return [...this.channels].sort().map((channel) => {
      const handler = snapshot.channels.get(channel)
      if (!handler) throw new Error(`Renderer references missing IPC channel ${JSON.stringify(channel)}; rebuild renderer before main/preload`)
      return handler
    })
  }
}
