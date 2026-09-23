import type { ESTree } from 'vite'
import { BindingResolver } from './bindings'
import type { AnalysisHost, DefinitionRecord, ParsedModule } from './types'

/** Read definitions without evaluating schemas, imports or implementations. */
export async function analyzeModule(code: string, file: string, host?: AnalysisHost): Promise<ParsedModule> {
  if (/\.d\.[cm]?ts(?:$|[?#])/.test(file)) return { analysis: { kind: 'ordinary' } }
  const bindings = new BindingResolver(code, file, host)
  const { root } = bindings
  const { program } = root
  const handlers = new Map<ESTree.Node, string>()

  async function candidate(node: ESTree.Node | null | undefined) {
    if (!node || !bindings.hasHandler(node)) return
    const origin = await bindings.resolve(node)
    if (origin?.kind === 'handler') handlers.set(node, origin.channel)
  }
  for (const node of program.body) {
    if (node.type === 'ExportDefaultDeclaration') await candidate(node.declaration)
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') continue
    if (node.declaration?.type === 'VariableDeclaration') {
      for (const item of node.declaration.declarations) await candidate(item.init)
    } else if (!node.source) {
      for (const item of node.specifiers) if (item.exportKind !== 'type') await candidate(item.local)
    }
  }
  // Factory aliases and preconfigured builders are ordinary helper modules.
  if (!handlers.size) return { program, analysis: { kind: 'ordinary' } }
  const definitions: DefinitionRecord[] = []
  for (const node of program.body) {
    if (node.type === 'TSExportAssignment') root.fail(node, 'CommonJS exports are not supported in IPC modules')
    if (node.type === 'ExportDefaultDeclaration' && node.declaration.type !== 'TSInterfaceDeclaration') root.fail(node, 'Default runtime exports are not supported in IPC modules')
    if (node.type === 'ExportAllDeclaration' && node.exportKind !== 'type') root.fail(node, 'Runtime re-exports are not supported in IPC modules')
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') continue
    const declaration = node.declaration
    if (declaration?.type === 'TSInterfaceDeclaration' || declaration?.type === 'TSTypeAliasDeclaration') continue
    if (declaration?.type === 'VariableDeclaration' && declaration.kind === 'const' && !declaration.declare) {
      for (const item of declaration.declarations) {
        const channel = item.init && handlers.get(item.init)
        if (item.id.type !== 'Identifier' || !channel) {
          return root.fail(item, 'IPC exports must use createIpcInvoke("channel").handler(fn), optionally through factory aliases or preconfigured builders')
        }
        definitions.push({ exportName: item.id.name, channel, moduleKey: file, line: root.position(item.start).line })
      }
    } else if (!declaration && (node.specifiers.length > 0 || !node.source) && node.specifiers.every(item => item.exportKind === 'type')) {
      continue
    } else {
      root.fail(node, 'IPC modules may only export IPC definitions and types; move shared runtime exports to another module')
    }
  }
  return { program, analysis: { kind: 'definition', definitions } }
}
