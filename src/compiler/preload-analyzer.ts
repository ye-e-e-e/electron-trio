import type { ESTree } from 'vite'
import { unwrapExpression } from './source-module'
import { SymbolResolver } from './symbol-resolver'

/** Resolve createPreload calls, then enforce the preload entry's export contract. */
export async function analyzePreloadEntry(code: string, file: string) {
  if (/\.d\.[cm]?ts(?:$|[?#])/.test(file)) return
  const symbols = new SymbolResolver<ESTree.CallExpression>(code, file, {
    targets: [{ source: 'electron-start', name: 'createPreload' }],
    async resolveCall(call, { resolve }) {
      const factory = await resolve(call.callee)
      if (
        factory?.kind === 'import' &&
        factory.source === 'electron-start' &&
        factory.name === 'createPreload'
      ) {
        return call
      }
    },
  })
  const { root } = symbols
  const declaration = root.program.body.find(
    (node) => node.type === 'ExportDefaultDeclaration',
  )
  const origin = declaration && (await symbols.resolve(declaration.declaration))
  const call = origin?.kind === 'value' ? origin.value : undefined
  if (!call) {
    // Factory helpers are ordinary modules; createPreload calls require a default export.
    for (const node of root.program.body) {
      const statement =
        node.type === 'ExportNamedDeclaration' ? node.declaration : node
      const expressions =
        statement?.type === 'VariableDeclaration'
          ? statement.declarations.map((item) => item.init)
          : statement?.type === 'ExpressionStatement'
            ? [statement.expression]
            : []
      for (const expression of expressions) {
        if (
          !expression ||
          unwrapExpression(expression).type !== 'CallExpression'
        )
          continue
        const value = await symbols.resolve(expression)
        if (value?.kind === 'value') {
          root.fail(
            expression,
            'Use export default createPreload(() => { ... })',
          )
        }
      }
    }
    return
  }
  if (!declaration || unwrapExpression(declaration.declaration) !== call) {
    return root.fail(call, 'Use export default createPreload(() => { ... })')
  }
  if (
    call.arguments.length !== 1 ||
    call.arguments[0].type === 'SpreadElement'
  ) {
    root.fail(call, 'createPreload requires one callback')
  }
  for (const node of root.program.body) {
    if (
      (node.type === 'ExportAllDeclaration' && node.exportKind !== 'type') ||
      (node.type === 'ExportNamedDeclaration' &&
        node.exportKind !== 'type' &&
        node.declaration?.type !== 'TSInterfaceDeclaration' &&
        node.declaration?.type !== 'TSTypeAliasDeclaration' &&
        (node.declaration ||
          node.specifiers.some((item) => item.exportKind !== 'type')))
    ) {
      root.fail(
        node,
        'Preload entries may only export createPreload as default and types',
      )
    }
  }
  const callee = unwrapExpression(call.callee)
  const binding =
    callee.type === 'Identifier' ? root.bindings.get(callee.name) : undefined
  // Keep import nodes to remove direct createPreload imports even without tree shaking.
  const directImport =
    binding && 'source' in binding && binding.source === 'electron-start'
      ? binding
      : undefined
  return {
    declaration,
    call,
    callback: call.arguments[0],
    importDeclaration: directImport?.importDeclaration,
    specifier: directImport?.specifier,
  }
}
