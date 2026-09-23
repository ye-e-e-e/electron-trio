import fs from 'node:fs/promises'
import type { AnalysisHost, ModuleAnalysis } from './types'
import type { DefinitionRegistry } from './registry'

export function isSourceModule(id: string) {
  const [file, query = ''] = id.split('?', 2)
  return !file.startsWith('\0') && /\.[cm]?[jt]sx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file)
    && !/(?:^|&)(?:raw|url|worker|sharedworker)(?:=|&|$)/.test(query)
}
export const definitionSignature = (analysis: ModuleAnalysis | undefined) => JSON.stringify(analysis?.kind === 'definition' ? analysis.definitions.map(({ exportName, channel }) => [exportName, channel]) : [])

/** Compare only the module already encountered by Vite, never scan its directory. */
export async function checkSourceContract(registry: DefinitionRegistry, code: string, id: string, host?: AnalysisHost) {
  let original: string
  try { original = await fs.readFile(id.split('?')[0], 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (original === code) return
  const before = await registry.analyze(original, id, host)
  const after = await registry.analyze(code, id, host)
  if (definitionSignature(before) !== definitionSignature(after)) throw new Error(`A preceding plugin changed IPC exports: ${id}. Place the renderer plugin before that plugin.`)
  if (!host) return
  // A transformed factory or builder can also change an already analyzed definition.
  for (const dependent of registry.affected(id.split('?')[0])) {
    if (dependent === id || registry.read(dependent)?.kind !== 'definition') continue
    const source = await fs.readFile(dependent.split('?')[0], 'utf8')
    const before = await registry.analyze(source, dependent, host)
    const after = await registry.analyze(source, dependent, {
      async load(specifier, importer) {
        const loaded = await host.load(specifier, importer)
        return loaded?.id === id ? { id, code } : loaded
      },
    })
    if (definitionSignature(before) !== definitionSignature(after)) throw new Error(`A preceding plugin changed IPC exports through ${id}: ${dependent}`)
  }
}
