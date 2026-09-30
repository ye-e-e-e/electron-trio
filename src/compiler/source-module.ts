import { parseSync } from 'vite'
import type { ESTree } from 'vite'

export type ImportBinding = {
  source: string
  name: string
  importDeclaration?: ESTree.ImportDeclaration
  specifier?: ESTree.ImportDeclaration['specifiers'][number]
}
type Binding = ImportBinding | { expression: ESTree.Node | null }

export class SourceModule {
  readonly program: ESTree.Program
  readonly bindings = new Map<string, Binding>()
  private readonly lineStarts = [0]

  constructor(
    readonly id: string,
    code: string,
  ) {
    for (const match of code.matchAll(/\r\n|[\n\r\u2028\u2029]/g))
      this.lineStarts.push(match.index + match[0].length)
    const result = parseSync(id, code, {
      lang: /\.[jt]sx(?:$|[?#])/.test(id)
        ? 'tsx'
        : /\.[cm]?js(?:$|[?#])/.test(id)
          ? 'js'
          : 'ts',
      sourceType: 'module',
      preserveParens: false,
      showSemanticErrors: true,
    })
    if (result.errors.length) {
      const error = result.errors[0]
      this.fail({ start: error.labels[0]?.start ?? 0 }, error.message)
    }
    this.program = result.program
    for (const node of this.program.body) {
      if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
        for (const item of node.specifiers) {
          if (item.type === 'ImportSpecifier' && item.importKind === 'type')
            continue
          this.bindings.set(item.local.name, {
            source: node.source.value,
            name:
              item.type === 'ImportSpecifier'
                ? name(item.imported)
                : item.type === 'ImportNamespaceSpecifier'
                  ? '*'
                  : 'default',
            importDeclaration: node,
            specifier: item,
          })
        }
      }
      const declaration =
        node.type === 'ExportNamedDeclaration' ? node.declaration : node
      if (declaration?.type === 'VariableDeclaration') {
        for (const item of declaration.declarations)
          if (item.id.type === 'Identifier') {
            this.bindings.set(item.id.name, {
              expression: declaration.kind === 'const' ? item.init : null,
            })
          }
      }
      if (
        (declaration?.type === 'FunctionDeclaration' ||
          declaration?.type === 'ClassDeclaration') &&
        declaration.id
      ) {
        this.bindings.set(declaration.id.name, { expression: declaration })
      }
    }
  }

  position(offset: number) {
    let low = 0
    let high = this.lineStarts.length
    while (low + 1 < high) {
      const middle = (low + high) >>> 1
      if (this.lineStarts[middle] <= offset) low = middle
      else high = middle
    }
    return { line: low + 1, column: offset - this.lineStarts[low] + 1 }
  }

  fail(node: Pick<ESTree.Node, 'start'>, message: string): never {
    const { line, column } = this.position(node.start)
    throw new Error(`${this.id}:${line}:${column}: ${message}`)
  }
}

function name(
  node: { type: 'Identifier'; name: string } | ESTree.StringLiteral,
) {
  return node.type === 'Identifier' ? node.name : node.value
}
export function memberName(node: ESTree.MemberExpression) {
  if (!node.computed && node.property.type === 'Identifier')
    return node.property.name
  if (
    node.computed &&
    node.property.type === 'Literal' &&
    typeof node.property.value === 'string'
  )
    return node.property.value
}
export function unwrapExpression(node: ESTree.Node): ESTree.Node {
  while (
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSInstantiationExpression'
  )
    node = node.expression
  return node
}
