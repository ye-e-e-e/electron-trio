import { expect, test } from 'vitest'
import { analyzeIpcModule } from '#/compiler/ipc-analyzer'

test.for([
  `import * as ipc from 'electron-trio'; export const run = ipc.createIpcInvoke('run').handler(fn)`,
  `import * as ipc from 'electron-trio'; export const run = ipc.createIpcInvoke('run').inputValidator(schema).handler(fn)`,
  `import * as ipc from 'electron-trio'; const define = ipc['createIpcInvoke']; export const run = define('run').handler(fn)`,
  `import { createIpcInvoke } from 'electron-trio'; const define = createIpcInvoke; const builder = define('run'); const validated = builder.inputValidator(schema); export const run = validated.handler(fn)`,
  `import { createIpcInvoke as define } from 'electron-trio'; const builder = define('run') as Builder; export const run = (builder!.handler(fn) satisfies Handler)`,
])(
  'resolves namespace imports and immutable local aliases: %s',
  async (code) => {
    expect((await analyzeIpcModule(code, '/definition.ts')).analysis).toEqual({
      kind: 'definition',
      definitions: [
        {
          moduleKey: '/definition.ts',
          exportName: 'run',
          channel: 'run',
          line: 1,
        },
      ],
    })
  },
)

test('does not recognize factories or builders imported from other modules', async () => {
  for (const code of [
    `import { createIpcInvoke } from './factory'; export const run = createIpcInvoke('run').handler(fn)`,
    `import * as ipc from './barrel'; export const run = ipc.createIpcInvoke('run').handler(fn)`,
    `import define from './factory'; export const run = define('run').handler(fn)`,
    `import { builder } from './builders'; export const run = builder.handler(fn)`,
  ])
    expect((await analyzeIpcModule(code, '/definition.ts')).analysis).toEqual({
      kind: 'ordinary',
    })
})

test('recognizes local builders without inspecting schema or handler imports', async () => {
  const { analysis } = await analyzeIpcModule(
    `
    import { createIpcInvoke } from 'electron-trio'
    import { schema, handler } from './missing'
    const builder = createIpcInvoke('run').inputValidator(schema)
    export const run = builder.handler(handler)
  `,
    '/definition.ts',
  )
  expect(
    analysis.kind === 'definition' && analysis.definitions[0].channel,
  ).toBe('run')
})

test('factory and builder exports remain ordinary until a handler is defined', async () => {
  for (const code of [
    `export { createIpcInvoke as define } from 'electron-trio'`,
    `import { createIpcInvoke } from 'electron-trio'; export const builder = createIpcInvoke('run').inputValidator(schema)`,
  ])
    expect((await analyzeIpcModule(code, '/helper.ts')).analysis).toEqual({
      kind: 'ordinary',
    })
})

test('reports malformed local builders at their declaration without executing them', async () => {
  for (const builder of [
    `createIpcInvoke(channel)`,
    `createIpcInvoke('')`,
    `createIpcInvoke('x', 'y')`,
    `createIpcInvoke('x').inputValidator()`,
    `createIpcInvoke('x').inputValidator(schema).inputValidator(schema)`,
  ]) {
    await expect(
      analyzeIpcModule(
        `import { createIpcInvoke } from 'electron-trio'; const builder = ${builder}; export const run = builder.handler(fn)`,
        '/definition.ts',
      ),
    ).rejects.toThrow(/\/definition.ts:1:\d+:/)
  }
})

test('recognized factory chains fail instead of retaining malformed implementations', async () => {
  for (const chain of [
    `ipc.createIpcInvoke('x').unknown().handler(fn)`,
    `ipc.createIpcInvoke('x').handler(fn)()`,
    `ipc.createIpcInvoke('x').handler(fn).unknown()`,
  ])
    await expect(
      analyzeIpcModule(
        `import * as ipc from 'electron-trio'; export const run = ${chain}`,
        '/definition.ts',
      ),
    ).rejects.toThrow('/definition.ts')
})

test('unrelated functions and shadowed parameters are not factory bindings', async () => {
  for (const code of [
    `import * as ipc from './fake'; export const run = ipc.createIpcInvoke('x').handler(fn)`,
    `import * as ipc from 'electron-trio'; export const run = (ipc: any) => ipc.createIpcInvoke('x').handler(fn)`,
    `import type * as ipc from 'electron-trio'; export const run = ipc.createIpcInvoke('x').handler(fn)`,
  ])
    expect((await analyzeIpcModule(code, '/definition.ts')).analysis).toEqual({
      kind: 'ordinary',
    })
})
