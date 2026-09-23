import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { analyzeModule } from '#/compiler/analyzer'
import { DefinitionRegistry } from '#/compiler/registry'

function modules(files: Record<string, string>) {
  return { load: vi.fn(async (source: string, importer: string) => {
    const id = path.posix.resolve(path.posix.dirname(importer), source + '.ts')
    if (!(id in files)) throw new Error(`Missing ${id}`)
    return { id, code: files[id] }
  }) }
}

test.for([
  `import * as ipc from 'electron-ipc-invoke'; export const run = ipc.createIpcInvoke('run').handler(fn)`,
  `import * as ipc from 'electron-ipc-invoke'; export const run = ipc.createIpcInvoke('run').inputValidator(schema).handler(fn)`,
  `import * as ipc from 'electron-ipc-invoke'; const define = ipc['createIpcInvoke']; export const run = define('run').handler(fn)`,
  `import { createIpcInvoke } from 'electron-ipc-invoke'; const define = createIpcInvoke; const builder = define('run'); const validated = builder.inputValidator(schema); export const run = validated.handler(fn)`,
  `import { createIpcInvoke as define } from 'electron-ipc-invoke'; const builder = define('run') as Builder; export const run = (builder!.handler(fn) satisfies Handler)`,
])('resolves namespace imports and immutable local aliases: %s', async code => {
  expect((await analyzeModule(code, '/definition.ts')).analysis).toEqual({
    kind: 'definition', definitions: [{ moduleKey: '/definition.ts', exportName: 'run', channel: 'run', line: 1 }],
  })
})

test('follows renamed, star and namespace reexports without reading handler or schema dependencies', async () => {
  const host = modules({
    '/factory.ts': `import * as ipc from 'electron-ipc-invoke'; export const define = ipc.createIpcInvoke`,
    '/builders.ts': `import { define } from './factory'; import { schema } from './never-read'; export const builder = define('configured').inputValidator(schema)`,
    '/barrel.ts': `export { define as renamed } from './factory'; export * from './builders'`,
    '/namespace.ts': `export * as group from './barrel'`,
  })
  const { analysis } = await analyzeModule(`
    import { group } from './namespace'
    import { fn } from './never-read'
    export const first = group.renamed('first').handler(fn)
    export const second = group.builder.handler(fn)
  `, '/definition.ts', host)
  expect(analysis.kind === 'definition' && analysis.definitions.map(({ exportName, channel }) => [exportName, channel]))
    .toEqual([['first', 'first'], ['second', 'configured']])
  expect(host.load.mock.calls.map(([source]) => source)).not.toContain('./never-read')
})

test('factory and builder exports remain ordinary until a handler is defined', async () => {
  for (const code of [
    `export { createIpcInvoke as define } from 'electron-ipc-invoke'`,
    `import { createIpcInvoke } from 'electron-ipc-invoke'; export const builder = createIpcInvoke('run').inputValidator(schema)`,
  ]) expect((await analyzeModule(code, '/helper.ts')).analysis).toEqual({ kind: 'ordinary' })
})

test('reports malformed imported builders at their declaration without executing them', async () => {
  for (const builder of [
    `createIpcInvoke(channel)`, `createIpcInvoke('')`, `createIpcInvoke('x', 'y')`,
    `createIpcInvoke('x').inputValidator()`,
    `createIpcInvoke('x').inputValidator(schema).inputValidator(schema)`,
  ]) {
    const host = modules({ '/builder.ts': `import { createIpcInvoke } from 'electron-ipc-invoke'; export const builder = ${builder}` })
    await expect(analyzeModule(`import { builder } from './builder'; export const run = builder.handler(fn)`, '/definition.ts', host))
      .rejects.toThrow(/\/builder.ts:1:\d+:/)
  }
})

test('recognized factory chains fail instead of retaining malformed implementations', async () => {
  for (const chain of [
    `ipc.createIpcInvoke('x').unknown().handler(fn)`,
    `ipc.createIpcInvoke('x').handler(fn)()`,
    `ipc.createIpcInvoke('x').handler(fn).unknown()`,
  ]) await expect(analyzeModule(`import * as ipc from 'electron-ipc-invoke'; export const run = ${chain}`, '/definition.ts'))
    .rejects.toThrow('/definition.ts')
})

test('unrelated functions, shadowed parameters and explicit exports are not factory bindings', async () => {
  const host = modules({
    '/fake.ts': `export function createIpcInvoke() { throw new Error('must not execute') }; export * from 'electron-ipc-invoke'`,
  })
  for (const code of [
    `import * as ipc from './fake'; export const run = ipc.createIpcInvoke('x').handler(fn)`,
    `import * as ipc from 'electron-ipc-invoke'; export const run = (ipc: any) => ipc.createIpcInvoke('x').handler(fn)`,
    `import type * as ipc from 'electron-ipc-invoke'; export const run = ipc.createIpcInvoke('x').handler(fn)`,
  ]) expect((await analyzeModule(code, '/definition.ts', host)).analysis).toEqual({ kind: 'ordinary' })
})

test('cyclic aliases and reexports terminate and other star branches can still resolve', async () => {
  const host = modules({
    '/first.ts': `export * from './second'; export * from 'electron-ipc-invoke'`,
    '/second.ts': `export * from './first'`,
    '/aliases.ts': `const first = second; const second = first; export { first as define }`,
  })
  expect((await analyzeModule(`import { createIpcInvoke } from './second'; export const run = createIpcInvoke('run').handler(fn)`, '/definition.ts', host)).analysis.kind)
    .toBe('definition')
  expect((await analyzeModule(`import { define } from './aliases'; export const run = define('run').handler(fn)`, '/definition.ts', host)).analysis.kind)
    .toBe('ordinary')
  expect(host.load.mock.calls.length).toBeLessThan(8)
})

test('unchanged definitions re-read builder dependencies and retain recovery dependencies after failures', async () => {
  const files = { '/builder.ts': `import { createIpcInvoke } from 'electron-ipc-invoke'; export const builder = createIpcInvoke('first')` }
  const host = modules(files)
  const registry = new DefinitionRegistry()
  const code = `import { builder } from './builder'; export const run = builder.handler(fn)`
  await registry.register(code, '/definition.ts', 'renderer', { host })
  expect(registry.affected('/builder.ts')).toEqual(['/definition.ts'])
  files['/builder.ts'] = files['/builder.ts'].replace('first', 'second')
  await registry.register(code, '/definition.ts', 'renderer', { host })
  expect(registry.definitions()[0].channel).toBe('second')
  files['/builder.ts'] = 'invalid @@@'
  await expect(registry.register(code, '/definition.ts', 'renderer', { host })).rejects.toThrow('/builder.ts')
  expect(registry.affected('/builder.ts')).toEqual(['/definition.ts'])
  expect(registry.read('/definition.ts')).toBeUndefined()
})
