import { expect, test } from 'vitest'
import { SymbolResolver } from '#/compiler/symbol-resolver'

test('resolves bindings using only the configured import identity', async () => {
  const name = 'macro'
  const target = { source: 'compile-time-api', name }
  for (const code of [
    `import { ${name} as define } from 'compile-time-api'; export default define`,
    `import * as api from 'compile-time-api'; export default api.${name}`,
    `import * as api from 'compile-time-api'; const define = api['${name}']; const alias = define; export default alias`,
    `import { ${name} as define } from 'compile-time-api'; export default (define as Factory)!`,
  ]) {
    const symbols = new SymbolResolver(code, '/entry.ts', {
      targets: [target],
    })
    const entry = symbols.root.program.body.find(
      (node) => node.type === 'ExportDefaultDeclaration',
    )!
    expect(await symbols.resolve(entry.declaration)).toEqual({
      kind: 'import',
      ...target,
    })
  }
})

test('does not follow factory imports from another module', async () => {
  for (const code of [
    `import { macro } from './factory'; export default macro`,
    `import * as api from './factory'; export default api.macro`,
    `import macro from './factory'; export default macro`,
    `import { macro } from '@factory'; const alias = macro; export default alias`,
  ]) {
    const symbols = new SymbolResolver(code, '/entry.ts', {
      targets: [{ source: 'compile-time-api', name: 'macro' }],
    })
    const entry = symbols.root.program.body.find(
      (node) => node.type === 'ExportDefaultDeclaration',
    )!
    expect(await symbols.resolve(entry.declaration)).toBeUndefined()
  }
})

test('does not treat type imports, mutable aliases or local functions as imported symbols', async () => {
  for (const code of [
    `import type { macro } from 'compile-time-api'; export default macro`,
    `import { type macro } from 'compile-time-api'; export default macro`,
    `import { macro } from 'compile-time-api'; let alias = macro; export default alias`,
    `const macro = () => {}; export default macro`,
    `const first = second; const second = first; export default first`,
    `import { macro } from 'another-package'; export default macro`,
  ]) {
    const symbols = new SymbolResolver(code, '/entry.ts', {
      targets: [{ source: 'compile-time-api', name: 'macro' }],
    })
    const entry = symbols.root.program.body.find(
      (node) => node.type === 'ExportDefaultDeclaration',
    )!
    expect(await symbols.resolve(entry.declaration)).toBeUndefined()
  }
})
