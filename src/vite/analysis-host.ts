import fs from 'node:fs/promises'
import type { Rolldown } from 'vite'
import type { AnalysisHost } from '#/compiler/types'
import { isSourceModule } from '#/compiler/source-contract'

export const ANALYSIS_REQUEST = 'electron-ipc-invoke:analysis'

/** Use Vite's aliases and resolution, but read definitions before proxy transforms. */
type Resolve = (...args: Parameters<Rolldown.PluginContext['resolve']>) => Promise<Rolldown.PartialResolvedId | null>

export function analysisHost(resolve: Resolve, watch?: (file: string) => void): AnalysisHost {
  return {
    async load(source, importer) {
      const resolved = await resolve(source, importer, { skipSelf: true, custom: { [ANALYSIS_REQUEST]: true } })
      if (!resolved) throw new Error(`Cannot resolve ${JSON.stringify(source)} from ${importer}`)
      if (resolved.external || !isSourceModule(resolved.id)) return
      watch?.(resolved.id.split('?')[0])
      return { id: resolved.id, code: await fs.readFile(resolved.id.split('?')[0], 'utf8') }
    },
  }
}
