import MagicString from 'magic-string'
import type { HookHandler, Plugin } from 'vite'
import type { DefinitionRecord } from '#/compiler/types'
import { checkSourceContract, isSourceModule } from '#/compiler/source-contract'
import type { PluginContext } from '#/context/context'
import { analysisHost } from '#/vite/analysis-host'
import { RESOLVED_MAIN_CALLER_PREFIX } from '#/vite/main-proxy-plugin/constants'
import { devMainModule, mainModule } from './main-module'
import { devPreloadModule, preloadModule } from './preload-module'

const ENTRY_MODULE_PREFIX = 'virtual:electron-ipc-invoke:entry:'

export function entryPlugin(context: PluginContext, target: 'main' | 'preload'): Plugin {
  const entries = new HostEntries(target)
  const definitions = new Map<string, readonly DefinitionRecord[]>()
  let releaseSignals: (() => void) | undefined
  return {
    name: `electron-ipc-invoke:${target}-entry`,
    enforce: 'pre',
    async buildStart(input) {
      if (!context.command) this.error('Initialize the renderer plugin before starting main/preload builds')
      await entries.prepare(this, input)
      if (context.command === 'build') {
        context.requireManifest()
        if (this.meta.watchMode) releaseSignals ??= context.buildSignals.open()
        for (const file of context.buildSignals.files(target)) this.addWatchFile(file)
      }
    },
    resolveId: {
      order: 'pre',
      handler(id) {
        return entries.resolve(id)
      },
    },
    load(id) {
      if (!entries.isGenerated(id)) return
      if (context.command === 'serve') {
        if (target === 'preload') return devPreloadModule(context.bridgeName)
        if (!context.devConnection) this.error('IPC development main environment is unavailable')
        return context.devConnection.then(devMainModule)
      }
      for (const file of context.buildSignals.files(target)) this.addWatchFile(file)
      return target === 'main'
        ? mainModule(context.requireManifest())
        : preloadModule(context.requireManifest(), context.bridgeName)
    },
    async transform(code, id) {
      if (!isSourceModule(id)) return
      if (target === 'preload') return entries.inject(code, id)
      const host = analysisHost(this.resolve.bind(this), file => this.addWatchFile(file))
      await checkSourceContract(context.registry, code, id, host)
      const analysis = await context.registry.analyze(code, id, host)
      if (analysis.kind === 'definition' && entries.has(id)) this.error('An IPC definition cannot also be a main/preload entry')
      if (context.command === 'build') {
        definitions.set(id, analysis.kind === 'definition' ? analysis.definitions : [])
        const selected = context.requireManifest().filter(record => record.moduleKey === id)
        if (selected.some(record => analysis.kind !== 'definition' || !analysis.definitions.some(actual => actual.exportName === record.exportName && actual.channel === record.channel))) {
          this.error(`IPC definition contract changed in ${id}; waiting for a successful renderer manifest`)
        }
      }
      return entries.inject(code, id)
    },
    buildEnd(error) {
      if (error || target !== 'main' || context.command !== 'build') return
      const channels = new Map<string, DefinitionRecord>()
      for (const id of this.getModuleIds()) for (const record of definitions.get(id) ?? []) {
        const previous = channels.get(record.channel)
        if (previous) this.error(`Duplicate IPC channel ${JSON.stringify(record.channel)}: ${previous.moduleKey}:${previous.line} and ${record.moduleKey}:${record.line}`)
        channels.set(record.channel, record)
      }
    },
    closeWatcher() {
      releaseSignals?.()
      releaseSignals = undefined
    },
  }
}

type BuildStart = HookHandler<NonNullable<Plugin['buildStart']>>

/** Entry injection shared by main and preload, independent of application mode. */
class HostEntries {
  private readonly entries = new Map<string, string>()
  private readonly generated = new Set<string>()

  constructor(private readonly target: 'main' | 'preload') {}

  async prepare(context: ThisParameterType<BuildStart>, input: Parameters<BuildStart>[0]) {
    this.entries.clear()
    this.generated.clear()
    const entry = input.input
    const inputs = typeof entry === 'string' ? [entry] : Array.isArray(entry) ? entry : Object.values(entry ?? {})
    if (!inputs.length || (this.target === 'main' && inputs.length !== 1)) context.error(`IPC ${this.target} requires ${this.target === 'main' ? 'one' : 'at least one'} entry`)
    for (const [index, name] of inputs.entries()) {
      const resolved = await context.resolve(name, undefined, { isEntry: true })
      if (!resolved || resolved.external) context.error(`Cannot resolve IPC ${this.target} entry: ${name}`)
      if (resolved.id.startsWith(RESOLVED_MAIN_CALLER_PREFIX)) context.error('An IPC definition cannot also be a main/preload entry')
      const id = ENTRY_MODULE_PREFIX + this.target + ':' + index
      this.entries.set(resolved.id, id)
      this.generated.add('\0' + id)
    }
  }

  resolve(id: string) {
    if (this.generated.has('\0' + id)) return { id: '\0' + id, moduleSideEffects: 'no-treeshake' as const }
  }

  isGenerated(id: string) { return this.generated.has(id) }
  has(id: string) { return this.entries.has(id) }

  inject(code: string, id: string) {
    const injected = this.entries.get(id)
    if (injected) return injectEntry(code, id, injected)
  }
}

function injectEntry(code: string, id: string, importId: string) {
  const output = new MagicString(code)
  const shebang = code.match(/^(?:\uFEFF)?#![^\n]*(?:\n|$)/)?.[0]
  const prefix = shebang && !shebang.endsWith('\n') ? '\n' : ''
  output.appendLeft(shebang?.length ?? 0, `${prefix}import ${JSON.stringify(importId)};\n`)
  return { code: output.toString(), map: output.generateMap({ source: id, includeContent: true, hires: true }) }
}
