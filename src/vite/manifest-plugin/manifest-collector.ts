import type { Rolldown } from 'vite'
import type { DefinitionRecord } from '#/compiler/types'

interface Build {
  readonly revision: number
  readonly outputs: Set<number>
  definitions?: readonly DefinitionRecord[]
}

/** Publish retained definitions only after every renderer output has succeeded. */
export class ManifestCollector {
  count = 0
  private revision = 0
  private readonly inputs = new WeakMap<object, Build>()
  private readonly completed = new Map<number, readonly DefinitionRecord[]>()
  private readonly finalizers = new WeakSet<object>()

  constructor(
    private readonly collectCandidates: (moduleIds: Iterable<string>) => readonly DefinitionRecord[],
    private readonly publishManifest: (definitions: readonly DefinitionRecord[]) => void,
  ) {}

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
    // A new build invocation must never combine an old output with a new one.
    this.invalidate()
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
          build.definitions = collector.collectCandidates(this.getModuleIds())
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
    const chunks = Object.values(bundle).filter(output => output.type === 'chunk')
    const definitions = (build.definitions ?? []).filter(({ moduleKey, exportName }) =>
      chunks.some(chunk => chunk.modules[moduleKey]?.renderedExports.includes(exportName)))
    this.completed.set(index, definitions)
    if (this.completed.size === this.count) {
      const combined = new Map<string, DefinitionRecord>()
      for (const records of this.completed.values()) for (const record of records) {
        const previous = combined.get(record.channel)
        if (previous && (previous.moduleKey !== record.moduleKey || previous.exportName !== record.exportName)) {
          throw new Error(`Renderer output manifests disagree for ${JSON.stringify(record.channel)}`)
        }
        combined.set(record.channel, record)
      }
      this.publishManifest([...combined.values()])
    }
  }
}
