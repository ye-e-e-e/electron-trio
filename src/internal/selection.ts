import type { Rolldown } from 'vite'
import { decodeChannel, PROXY } from './generate.js'

interface Build {
  readonly revision: number
  readonly outputs: Set<number>
}

/** Commit the union of channels only after every renderer output has succeeded. */
export class RendererOutputs {
  count = 0
  private revision = 0
  private readonly inputs = new WeakMap<object, Build>()
  private readonly completed = new Map<number, Set<string>>()
  private readonly finalizers = new WeakSet<object>()

  constructor(private readonly publish: (channels: ReadonlySet<string>) => void) {}

  invalidate = () => {
    this.revision++
    this.completed.clear()
  }

  begin(input: Rolldown.NormalizedInputOptions) {
    const outputs = this.inputs.get(input)?.outputs ?? new Set<number>()
    for (const output of outputs) this.completed.delete(output)
    this.inputs.set(input, { revision: this.revision, outputs })
  }

  configure(input: Rolldown.InputOptions) {
    // Vite 8 supplies resolved outputs here, including expanded library formats.
    const output = (input as Rolldown.WatchOptions).output
    if (!output) throw new Error('IPC renderer requires Vite 8 build output options')
    const outputs = Array.isArray(output) ? output : [output]
    this.count = outputs.length
    outputs.forEach((output, index) => {
      output.plugins = [this.removeFinalizers(output.plugins), this.finalizer(index)]
    })
  }

  private removeFinalizers(plugins: Rolldown.OutputOptions['plugins']): Rolldown.OutputOptions['plugins'] {
    if (Array.isArray(plugins)) return plugins.map((plugin) => this.removeFinalizers(plugin))
    return plugins && typeof plugins === 'object' && this.finalizers.has(plugins) ? undefined : plugins
  }

  private finalizer(index: number): Rolldown.Plugin {
    let build: Build | undefined
    const collector = this
    const plugin: Rolldown.Plugin = {
      name: 'electron-ipc-invoke:renderer-output',
      renderStart: {
        order: 'pre',
        handler(_output, input) {
          build = collector.inputs.get(input)
          if (!build) this.error('IPC renderer build context is unavailable')
          build.outputs.add(index)
          if (build.revision === collector.revision) collector.completed.delete(index)
        },
      },
      // These output plugins run after user input/output hooks, including post hooks.
      generateBundle: {
        order: 'post',
        handler(_output, bundle, isWrite) { if (!isWrite && build) collector.complete(index, build, bundle) },
      },
      writeBundle: {
        order: 'post', sequential: true,
        handler(_output, bundle) { if (build) collector.complete(index, build, bundle) },
      },
    }
    this.finalizers.add(plugin)
    return plugin
  }

  private complete(index: number, build: Build, bundle: Rolldown.OutputBundle) {
    if (build.revision !== this.revision) return
    const channels = new Set<string>()
    for (const output of Object.values(bundle)) {
      if (output.type !== 'chunk') continue
      for (const [id, module] of Object.entries(output.modules)) {
        if (id.startsWith(PROXY) && module.renderedLength > 0) channels.add(decodeChannel(id.slice(PROXY.length)))
      }
    }
    this.completed.set(index, channels)
    if (this.completed.size === this.count) this.publish(new Set([...this.completed.values()].flatMap((channels) => [...channels])))
  }
}
