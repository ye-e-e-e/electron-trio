import { parseSync } from 'vite'
import type { ESTree } from 'vite'

export interface HandlerMeta {
  name: string
  channel: string
  file: string
  line: number
}

/** Read definitions without evaluating their schemas, imports or implementations. */
export function parseHandlers(code: string, file: string): HandlerMeta[] {
  const lineStarts = [0]
  for (const match of code.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) lineStarts.push(match.index + match[0].length)
  function position(offset: number) {
    let low = 0
    let high = lineStarts.length
    while (low + 1 < high) {
      const middle = (low + high) >>> 1
      if (lineStarts[middle] <= offset) low = middle
      else high = middle
    }
    return { line: low + 1, column: offset - lineStarts[low] + 1 }
  }
  function fail(node: Pick<ESTree.Node, 'start'>, message: string): never {
    const { line, column } = position(node.start)
    throw new Error(`${file}:${line}:${column}: ${message}`)
  }

  const result = parseSync(file, code, {
    lang: 'ts',
    sourceType: 'module',
    preserveParens: false,
    showSemanticErrors: true,
  })
  if (result.errors.length) {
    const error = result.errors[0]
    fail({ start: error.labels[0]?.start ?? 0 }, error.message)
  }
  const program = result.program
  const aliases = new Set<string>()
  const handlers: HandlerMeta[] = []

  for (const node of program.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== 'electron-ipc-invoke' || node.importKind === 'type') continue
    for (const specifier of node.specifiers) {
      if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') continue
      const name = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
      if (name === 'createIpcInvoke') {
        aliases.add(specifier.local.name)
      }
    }
  }

  function readDefinition(declaration: ESTree.VariableDeclarator) {
    const handler = declaration.init
    if (declaration.id.type !== 'Identifier' || handler?.type !== 'CallExpression' ||
      handler.callee.type !== 'MemberExpression' || handler.callee.computed ||
      handler.callee.property.type !== 'Identifier' || handler.callee.property.name !== 'handler' ||
      handler.arguments.length !== 1 || handler.arguments[0].type === 'SpreadElement') {
      fail(declaration, 'IPC exports must use: export const name = createIpcInvoke("channel").handler(fn), optionally with .inputValidator(schema) before .handler(fn)')
    }
    let builder = handler.callee.object
    if (builder.type === 'CallExpression' && builder.callee.type === 'MemberExpression') {
      if (builder.callee.computed || builder.callee.property.type !== 'Identifier' ||
        builder.callee.property.name !== 'inputValidator' || builder.arguments.length !== 1 ||
        builder.arguments[0].type === 'SpreadElement') {
        fail(declaration, 'Only .inputValidator(schema) may appear between createIpcInvoke("channel") and .handler(fn)')
      }
      builder = builder.callee.object
    }
    if (builder.type !== 'CallExpression' || builder.callee.type !== 'Identifier' ||
      !aliases.has(builder.callee.name) || builder.arguments.length !== 1 ||
      builder.arguments[0].type !== 'Literal' || typeof builder.arguments[0].value !== 'string' ||
      !builder.arguments[0].value.trim()) {
      fail(declaration, 'Import createIpcInvoke from "electron-ipc-invoke" and use a non-empty string literal channel')
    }
    handlers.push({ name: declaration.id.name, channel: builder.arguments[0].value, file, line: position(declaration.start).line })
  }

  for (const node of program.body) {
    if (node.type === 'TSExportAssignment') fail(node, 'CommonJS exports are not supported in IPC modules')
    if (node.type === 'ExportDefaultDeclaration' && node.declaration.type !== 'TSInterfaceDeclaration') fail(node, 'Default runtime exports are not supported in IPC modules')
    if (node.type === 'ExportAllDeclaration' && node.exportKind !== 'type') fail(node, 'Runtime re-exports are not supported in IPC modules')
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') continue
    const declaration = node.declaration
    if (declaration?.type === 'TSInterfaceDeclaration' || declaration?.type === 'TSTypeAliasDeclaration') continue
    if (declaration?.type === 'VariableDeclaration' && declaration.kind === 'const' && !declaration.declare) {
      for (const item of declaration.declarations) readDefinition(item)
    } else if (!declaration && (node.specifiers.length > 0 || !node.source) &&
      node.specifiers.every((specifier) => specifier.exportKind === 'type')) {
      continue
    } else {
      fail(node, 'IPC modules may only export IPC definitions and types; move shared runtime exports to another module')
    }
  }

  // Only top-level exports define the renderer API. Private helpers are main
  // code; Vite handles their scope, syntax transforms and dependencies.
  return handlers
}
