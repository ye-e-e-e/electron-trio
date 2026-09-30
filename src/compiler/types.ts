import type { ESTree } from 'vite'

export type Caller = 'renderer' | 'main'
export interface DefinitionRecord {
  moduleKey: string
  exportName: string
  channel: string
  line: number
}
export type ModuleAnalysis =
  | { kind: 'ordinary' }
  | { kind: 'definition'; definitions: readonly DefinitionRecord[] }
export interface ParsedModule {
  program?: ESTree.Program
  analysis: ModuleAnalysis
}

export interface DefinitionTarget {
  caller: Caller
  moduleKey: string
  exportName: string
}
