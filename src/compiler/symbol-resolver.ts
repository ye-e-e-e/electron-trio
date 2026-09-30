import type { ESTree } from 'vite'
import { SourceModule, memberName, unwrapExpression } from './source-module'
import type { ImportBinding } from './source-module'

export type ResolvedSymbol<Value = never> =
  | { kind: 'import'; source: string; name: string }
  | { kind: 'namespace'; source: string }
  | { kind: 'value'; value: Value }

export interface SymbolContext<Value> {
  module: SourceModule
  resolve(
    node: ESTree.Node | null | undefined,
  ): Promise<ResolvedSymbol<Value> | undefined>
}

interface SymbolResolverOptions<Value> {
  /** Imports to identify without loading or evaluating their implementation. */
  targets: readonly ImportBinding[]
  resolveCall?(
    node: ESTree.CallExpression,
    context: SymbolContext<Value>,
  ): Promise<Value | undefined>
}

/** Identify direct imports and immutable aliases within one module. */
export class SymbolResolver<Value = never> {
  readonly root: SourceModule

  constructor(
    code: string,
    file: string,
    private readonly options: SymbolResolverOptions<Value>,
  ) {
    this.root = new SourceModule(file, code)
  }

  async resolve(
    node: ESTree.Node | null | undefined,
    visited = new Set<string>(),
  ): Promise<ResolvedSymbol<Value> | undefined> {
    if (!node) return
    node = unwrapExpression(node)
    if (node.type === 'Identifier') return this.local(node.name, visited)
    if (node.type === 'MemberExpression') {
      const object = await this.resolve(node.object, visited)
      const property = memberName(node)
      if (object?.kind === 'namespace' && property) {
        return this.imported({ source: object.source, name: property })
      }
      return
    }
    if (node.type === 'CallExpression') {
      const value = await this.options.resolveCall?.(node, {
        module: this.root,
        resolve: (expression) => this.resolve(expression, visited),
      })
      if (value !== undefined) return { kind: 'value', value }
    }
  }

  private async local(
    local: string,
    visited: Set<string>,
  ): Promise<ResolvedSymbol<Value> | undefined> {
    if (visited.has(local)) return
    const binding = this.root.bindings.get(local)
    if (!binding) return
    return 'source' in binding
      ? this.imported(binding)
      : this.resolve(binding.expression, new Set(visited).add(local))
  }

  private imported(binding: ImportBinding): ResolvedSymbol<Value> | undefined {
    const targets = this.options.targets.filter(
      (target) => target.source === binding.source,
    )
    if (!targets.length) return
    if (binding.name === '*')
      return { kind: 'namespace', source: binding.source }
    return targets.some((target) => target.name === binding.name)
      ? { kind: 'import', source: binding.source, name: binding.name }
      : undefined
  }
}
