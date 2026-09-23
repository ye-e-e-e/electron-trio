import { parseSync } from 'vite'
import type { ESTree } from 'vite'
import type { AnalysisHost } from './types'

type ImportBinding = { source: string; name: string }
type Binding = ImportBinding | { expression: ESTree.Node | null }
type Origin = { kind: 'factory' } | { kind: 'namespace'; module: Module; source: string }
  | { kind: 'builder'; channel: string; validated: boolean } | { kind: 'handler'; channel: string }

class Module {
  readonly program: ESTree.Program
  readonly bindings = new Map<string, Binding>()
  readonly exports = new Map<string, Binding | { local: string }>()
  readonly stars: string[] = []
  private readonly lineStarts = [0]

  constructor(readonly id: string, code: string) {
    for (const match of code.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) this.lineStarts.push(match.index + match[0].length)
    const result = parseSync(id, code, {
      lang: /\.[jt]sx(?:$|[?#])/.test(id) ? 'tsx' : /\.[cm]?js(?:$|[?#])/.test(id) ? 'js' : 'ts',
      sourceType: 'module', preserveParens: false, showSemanticErrors: true,
    })
    if (result.errors.length) {
      const error = result.errors[0]
      this.fail({ start: error.labels[0]?.start ?? 0 }, error.message)
    }
    this.program = result.program
    for (const node of this.program.body) {
      if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
        for (const item of node.specifiers) {
          if (item.type === 'ImportSpecifier' && item.importKind === 'type') continue
          this.bindings.set(item.local.name, { source: node.source.value, name: item.type === 'ImportSpecifier'
            ? name(item.imported) : item.type === 'ImportNamespaceSpecifier' ? '*' : 'default' })
        }
      }
      const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node
      if (declaration?.type === 'VariableDeclaration') {
        for (const item of declaration.declarations) if (item.id.type === 'Identifier') {
          this.bindings.set(item.id.name, { expression: declaration.kind === 'const' ? item.init : null })
          if (node.type === 'ExportNamedDeclaration') this.exports.set(item.id.name, { local: item.id.name })
        }
      }
      if ((declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') && declaration.id) {
        this.bindings.set(declaration.id.name, { expression: declaration })
        if (node.type === 'ExportNamedDeclaration') this.exports.set(declaration.id.name, { local: declaration.id.name })
      }
      if (node.type === 'ExportNamedDeclaration' && node.exportKind !== 'type') {
        for (const item of node.specifiers) if (item.exportKind !== 'type') {
          this.exports.set(name(item.exported), node.source
            ? { source: node.source.value, name: name(item.local) } : { local: name(item.local) })
        }
      }
      if (node.type === 'ExportAllDeclaration' && node.exportKind !== 'type') {
        if (node.exported) this.exports.set(name(node.exported), { source: node.source.value, name: '*' })
        else this.stars.push(node.source.value)
      }
      if (node.type === 'ExportDefaultDeclaration') this.exports.set('default', { expression: node.declaration })
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

/** Resolve only the expression feeding .handler(), without evaluating user code. */
export class BindingResolver {
  readonly root: Module
  private readonly modules = new Map<string, Module>()
  private readonly imports = new Map<string, Promise<Module | undefined>>()

  constructor(code: string, file: string, private readonly host?: AnalysisHost) {
    this.root = new Module(file, code)
    this.modules.set(file, this.root)
  }

  hasHandler(node: ESTree.Node | null | undefined, visited = new Set<string>()): boolean {
    if (!node) return false
    node = unwrap(node)
    if (node.type === 'Identifier') {
      if (visited.has(node.name)) return false
      const binding = this.root.bindings.get(node.name)
      return !!binding && 'expression' in binding && this.hasHandler(binding.expression, new Set(visited).add(node.name))
    }
    if (node.type === 'CallExpression') {
      return (node.callee.type === 'MemberExpression' && memberName(node.callee) === 'handler') || this.hasHandler(node.callee, visited)
    }
    if (node.type === 'MemberExpression') return this.hasHandler(node.object, visited)
    return false
  }

  async resolve(node: ESTree.Node | null | undefined, module = this.root, visited = new Set<string>()): Promise<Origin | undefined> {
    if (!node) return
    node = unwrap(node)
    if (node.type === 'Identifier') return this.local(module, node.name, visited)
    if (node.type === 'MemberExpression') {
      const object = await this.resolve(node.object, module, visited)
      const property = memberName(node)
      if (object?.kind === 'namespace' && property) return this.imported(object.module, { source: object.source, name: property }, visited)
      return
    }
    if (node.type !== 'CallExpression') return
    const callee = unwrap(node.callee)
    const object = callee.type === 'MemberExpression' ? await this.resolve(callee.object, module, visited) : undefined
    const property = callee.type === 'MemberExpression' ? memberName(callee) : undefined
    const factory = callee.type !== 'MemberExpression' ? await this.resolve(callee, module, visited)
      : object?.kind === 'namespace' && property ? await this.imported(object.module, { source: object.source, name: property }, visited) : undefined
    if (factory?.kind === 'factory') {
      const channel = node.arguments[0]
      if (node.arguments.length !== 1 || channel.type !== 'Literal' || typeof channel.value !== 'string' || !channel.value.trim()) {
        return module.fail(node, 'Use createIpcInvoke with a non-empty string literal channel')
      }
      return { kind: 'builder', channel: channel.value, validated: false }
    }
    if (factory?.kind === 'builder' || factory?.kind === 'handler' || object?.kind === 'handler' || object?.kind === 'factory') {
      return module.fail(node, 'Use a factory call followed by optional .inputValidator(schema) and a final .handler(fn)')
    }
    if (object?.kind !== 'builder') return
    const builder = object
    const method = property
    if ((method !== 'handler' && method !== 'inputValidator') || (method === 'inputValidator' && builder.validated)) {
      module.fail(node, 'Only .inputValidator(schema) may appear between createIpcInvoke("channel") and .handler(fn)')
    }
    if (node.arguments.length !== 1 || node.arguments[0].type === 'SpreadElement') {
      module.fail(node, `.${method} requires exactly one argument`)
    }
    return method === 'handler' ? { kind: 'handler', channel: builder.channel } : { ...builder, validated: true }
  }

  private async local(module: Module, local: string, visited: Set<string>): Promise<Origin | undefined> {
    const key = JSON.stringify([module.id, 'local', local])
    if (visited.has(key)) return
    const binding = module.bindings.get(local)
    if (!binding) return
    const next = new Set(visited).add(key)
    return 'source' in binding ? this.imported(module, binding, next) : this.resolve(binding.expression, module, next)
  }

  private async imported(module: Module, binding: ImportBinding, visited: Set<string>): Promise<Origin | undefined> {
    if (binding.name === '*') return { kind: 'namespace', module, source: binding.source }
    if (binding.source === 'electron-ipc-invoke') return binding.name === 'createIpcInvoke' ? { kind: 'factory' } : undefined
    const key = JSON.stringify([module.id, binding.source])
    let pending = this.imports.get(key)
    if (!pending) {
      pending = (async () => {
        const loaded = await this.host?.load(binding.source, module.id)
        if (!loaded) return
        let target = this.modules.get(loaded.id)
        if (!target) {
          target = new Module(loaded.id, loaded.code)
          this.modules.set(loaded.id, target)
        }
        return target
      })()
      this.imports.set(key, pending)
    }
    const target = await pending
    return target && this.exported(target, binding.name, visited)
  }

  private async exported(module: Module, exported: string, visited: Set<string>): Promise<Origin | undefined> {
    const key = JSON.stringify([module.id, 'export', exported])
    if (visited.has(key)) return
    const next = new Set(visited).add(key)
    const binding = module.exports.get(exported)
    if (binding) {
      if ('local' in binding) return this.local(module, binding.local, next)
      if ('source' in binding) return this.imported(module, binding, next)
      return this.resolve(binding.expression, module, next)
    }
    if (exported !== 'default') for (const source of module.stars) {
      const origin = await this.imported(module, { source, name: exported }, next)
      if (origin) return origin
    }
  }
}

function name(node: { type: 'Identifier'; name: string } | ESTree.StringLiteral) { return node.type === 'Identifier' ? node.name : node.value }
function memberName(node: ESTree.MemberExpression) {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') return node.property.value
}
function unwrap(node: ESTree.Node): ESTree.Node {
  while (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression' || node.type === 'TSInstantiationExpression') node = node.expression
  return node
}
