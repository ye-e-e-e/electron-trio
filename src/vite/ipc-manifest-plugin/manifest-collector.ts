import type { Rolldown } from 'vite'
import type { DefinitionRecord } from '#/compiler/types'
import { ipcDefinitionId } from '#/vite/ipc-plugin/module-id'

/** Publish retained definitions only after every renderer output has succeeded. */
export class IpcManifestCollector {
  private count = 0
  private readonly completed = new Map<number, readonly DefinitionRecord[]>()
  private readonly finalizers = new WeakSet<object>()

  constructor(
    private readonly collectCandidates: (
      moduleIds: Iterable<string>,
    ) => readonly DefinitionRecord[],
    private readonly publishManifest: (
      definitions: readonly DefinitionRecord[],
    ) => void,
  ) {}

  configure(input: Rolldown.InputOptions) {
    // A new build invocation must never combine an old output with a new one.
    this.completed.clear()
    // Vite 8 supplies resolved outputs here, including expanded library formats.
    const output = (input as Rolldown.WatchOptions).output
    if (!output)
      throw new Error('IPC renderer requires Vite 8 build output options')
    const outputs = Array.isArray(output) ? output : [output]
    this.count = outputs.length
    outputs.forEach((output, index) => {
      output.plugins = [
        this.removeFinalizers(output.plugins),
        this.finalizer(index),
      ]
    })
  }

  private removeFinalizers(
    plugins: Rolldown.OutputOptions['plugins'],
  ): Rolldown.OutputOptions['plugins'] {
    if (Array.isArray(plugins))
      return plugins.map((plugin) => this.removeFinalizers(plugin))
    return plugins &&
      typeof plugins === 'object' &&
      this.finalizers.has(plugins)
      ? undefined
      : plugins
  }

  private finalizer(index: number): Rolldown.Plugin {
    let definitions: readonly DefinitionRecord[] = []
    const collector = this
    const plugin: Rolldown.Plugin = {
      name: 'electron-trio:ipc-manifest-output',
      renderStart: {
        order: 'pre',
        handler() {
          definitions = collector.collectCandidates(this.getModuleIds())
        },
      },
      // These output plugins run after user input/output hooks, including post hooks.
      generateBundle: {
        order: 'post',
        handler(_output, bundle, isWrite) {
          if (!isWrite) collector.complete(index, definitions, bundle)
        },
      },
      writeBundle: {
        order: 'post',
        sequential: true,
        handler(_output, bundle) {
          collector.complete(index, definitions, bundle)
        },
      },
    }
    this.finalizers.add(plugin)
    return plugin
  }

  private complete(
    index: number,
    candidates: readonly DefinitionRecord[],
    bundle: Rolldown.OutputBundle,
  ) {
    const chunks = Object.values(bundle).filter(
      (output) => output.type === 'chunk',
    )
    const definitions = candidates.filter(({ moduleKey, exportName }) =>
      chunks.some((chunk) =>
        Object.entries(chunk.modules).some(
          ([id, module]) =>
            ipcDefinitionId(id) === moduleKey &&
            module.renderedExports.includes(exportName),
        ),
      ),
    )
    this.completed.set(index, definitions)
    if (this.completed.size === this.count) {
      const combined = new Map<string, DefinitionRecord>()
      for (const records of this.completed.values())
        for (const record of records) {
          const previous = combined.get(record.channel)
          if (
            previous &&
            (previous.moduleKey !== record.moduleKey ||
              previous.exportName !== record.exportName)
          ) {
            throw new Error(
              `Renderer output manifests disagree for ${JSON.stringify(record.channel)}`,
            )
          }
          combined.set(record.channel, record)
        }
      this.publishManifest([...combined.values()])
    }
  }
}
