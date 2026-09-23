import type { ESTree } from 'vite'

export type Caller = 'renderer' | 'main'
export interface DefinitionRecord {
  moduleKey: string
  exportName: string
  channel: string
  line: number
}
export type ModuleAnalysis = { kind: 'ordinary' } | { kind: 'definition'; definitions: readonly DefinitionRecord[] }
export interface ParsedModule {
  program?: ESTree.Program
  analysis: ModuleAnalysis
}

/** Supplied by the bundler; the compiler does not resolve or read files itself. */
export interface AnalysisHost {
  load(source: string, importer: string): Promise<{ id: string; code: string } | undefined>
}

export interface DefinitionTarget {
  caller: Caller
  moduleKey: string
  exportName: string
}
