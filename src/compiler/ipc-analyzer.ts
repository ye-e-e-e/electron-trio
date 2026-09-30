import type { ESTree } from 'vite'
import { memberName, unwrapExpression } from './source-module'
import type { SourceModule } from './source-module'
import { SymbolResolver } from './symbol-resolver'
import type { ResolvedSymbol, SymbolContext } from './symbol-resolver'
import type { DefinitionRecord, ParsedModule } from './types'

/** Read definitions without evaluating schemas, imports or implementations. */
export async function analyzeIpcModule(
  code: string,
  file: string,
): Promise<ParsedModule> {
  if (/\.d\.[cm]?ts(?:$|[?#])/.test(file))
    return { analysis: { kind: 'ordinary' } }
  const symbols = new SymbolResolver<IpcValue>(code, file, {
    targets: [{ source: 'electron-start', name: 'createIpcInvoke' }],
    resolveCall: analyzeIpcCall,
  })
  const { root } = symbols
  const { program } = root
  const handlers = new Map<ESTree.Node, string>()

  async function candidate(node: ESTree.Node | null | undefined) {
    if (!node || !hasHandler(root, node)) return
    const origin = await symbols.resolve(node)
    if (origin?.kind === 'value' && origin.value.kind === 'handler')
      handlers.set(node, origin.value.channel)
  }
  for (const node of program.body) {
    if (node.type === 'ExportDefaultDeclaration')
      await candidate(node.declaration)
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type')
      continue
    if (node.declaration?.type === 'VariableDeclaration') {
      for (const item of node.declaration.declarations)
        await candidate(item.init)
    } else if (!node.source) {
      for (const item of node.specifiers)
        if (item.exportKind !== 'type') await candidate(item.local)
    }
  }
  // Factory aliases and preconfigured builders are ordinary helper modules.
  if (!handlers.size) return { program, analysis: { kind: 'ordinary' } }
  const definitions: DefinitionRecord[] = []
  for (const node of program.body) {
    if (node.type === 'TSExportAssignment')
      root.fail(node, 'CommonJS exports are not supported in IPC modules')
    if (
      node.type === 'ExportDefaultDeclaration' &&
      node.declaration.type !== 'TSInterfaceDeclaration'
    )
      root.fail(
        node,
        'Default runtime exports are not supported in IPC modules',
      )
    if (node.type === 'ExportAllDeclaration' && node.exportKind !== 'type')
      root.fail(node, 'Runtime re-exports are not supported in IPC modules')
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type')
      continue
    const declaration = node.declaration
    if (
      declaration?.type === 'TSInterfaceDeclaration' ||
      declaration?.type === 'TSTypeAliasDeclaration'
    )
      continue
    if (
      declaration?.type === 'VariableDeclaration' &&
      declaration.kind === 'const' &&
      !declaration.declare
    ) {
      for (const item of declaration.declarations) {
        const channel = item.init && handlers.get(item.init)
        if (item.id.type !== 'Identifier' || !channel) {
          return root.fail(
            item,
            'IPC exports must use createIpcInvoke("channel").handler(fn), optionally through factory aliases or preconfigured builders',
          )
        }
        definitions.push({
          exportName: item.id.name,
          channel,
          moduleKey: file,
          line: root.position(item.start).line,
        })
      }
    } else if (
      !declaration &&
      (node.specifiers.length > 0 || !node.source) &&
      node.specifiers.every((item) => item.exportKind === 'type')
    ) {
      continue
    } else {
      root.fail(
        node,
        'IPC modules may only export IPC definitions and types; move shared runtime exports to another module',
      )
    }
  }
  return { program, analysis: { kind: 'definition', definitions } }
}

type IpcValue =
  | { kind: 'builder'; channel: string; validated: boolean }
  | { kind: 'handler'; channel: string }

const isFactory = (value: ResolvedSymbol<IpcValue> | undefined) =>
  value?.kind === 'import' &&
  value.source === 'electron-start' &&
  value.name === 'createIpcInvoke'

async function analyzeIpcCall(
  node: ESTree.CallExpression,
  { module, resolve }: SymbolContext<IpcValue>,
): Promise<IpcValue | undefined> {
  const callee = unwrapExpression(node.callee)
  const objectSymbol =
    callee.type === 'MemberExpression'
      ? await resolve(callee.object)
      : undefined
  const object = objectSymbol?.kind === 'value' ? objectSymbol.value : undefined
  const property =
    callee.type === 'MemberExpression' ? memberName(callee) : undefined
  const factory =
    callee.type !== 'MemberExpression' || objectSymbol?.kind === 'namespace'
      ? await resolve(callee)
      : undefined
  if (isFactory(factory)) {
    const channel = node.arguments[0]
    if (
      node.arguments.length !== 1 ||
      channel.type !== 'Literal' ||
      typeof channel.value !== 'string' ||
      !channel.value.trim()
    ) {
      return module.fail(
        node,
        'Use createIpcInvoke with a non-empty string literal channel',
      )
    }
    return { kind: 'builder', channel: channel.value, validated: false }
  }
  if (
    factory?.kind === 'value' ||
    object?.kind === 'handler' ||
    isFactory(objectSymbol)
  ) {
    return module.fail(
      node,
      'Use a factory call followed by optional .inputValidator(schema) and a final .handler(fn)',
    )
  }
  if (object?.kind !== 'builder') return
  if (
    (property !== 'handler' && property !== 'inputValidator') ||
    (property === 'inputValidator' && object.validated)
  ) {
    module.fail(
      node,
      'Only .inputValidator(schema) may appear between createIpcInvoke("channel") and .handler(fn)',
    )
  }
  if (
    node.arguments.length !== 1 ||
    node.arguments[0].type === 'SpreadElement'
  ) {
    module.fail(node, `.${property} requires exactly one argument`)
  }
  return property === 'handler'
    ? { kind: 'handler', channel: object.channel }
    : { ...object, validated: true }
}

function hasHandler(
  module: SourceModule,
  node: ESTree.Node | null | undefined,
  visited = new Set<string>(),
): boolean {
  if (!node) return false
  node = unwrapExpression(node)
  if (node.type === 'Identifier') {
    if (visited.has(node.name)) return false
    const binding = module.bindings.get(node.name)
    return (
      !!binding &&
      'expression' in binding &&
      hasHandler(module, binding.expression, new Set(visited).add(node.name))
    )
  }
  if (node.type === 'CallExpression') {
    return (
      (node.callee.type === 'MemberExpression' &&
        memberName(node.callee) === 'handler') ||
      hasHandler(module, node.callee, visited)
    )
  }
  if (node.type === 'MemberExpression')
    return hasHandler(module, node.object, visited)
  return false
}
