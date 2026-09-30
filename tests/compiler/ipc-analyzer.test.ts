import { expect, test } from 'vitest'
import { analyzeIpcModule } from '#/compiler/ipc-analyzer'

const header = `import { createIpcInvoke as define } from 'electron-start';\n`
const definition = `export const run = define('run').inputValidator(schema).handler(fn)`
const parse = async (code: string) => {
  const { analysis } = await analyzeIpcModule(code, 'test.ipc.ts')
  return analysis.kind === 'definition' ? analysis.definitions : []
}

test('top-level exports provide names, literal channels and source locations', async () => {
  expect(
    await parse(`// 😀中文\r\n${header}
    export const first = (define('😀中文').inputValidator(schema).handler(fn)),
      second = define('other').handler(fn);
  `),
  ).toStrictEqual([
    {
      exportName: 'first',
      channel: '😀中文',
      moduleKey: 'test.ipc.ts',
      line: 4,
    },
    {
      exportName: 'second',
      channel: 'other',
      moduleKey: 'test.ipc.ts',
      line: 5,
    },
  ])
  await expect(parse(header + 'export const run = ;')).rejects.toThrow(
    /test\.ipc\.ts:2:\d+: Unexpected token/,
  )
})

test('private main code and type exports do not become IPC exports', async () => {
  const code = `${header}
    const local = define('local').inputValidator(schema).handler(fn);
    const factory = (channel: string) => define(channel).inputValidator(schema).handler(fn);
    function helper(define: Function) { return define(1) }
    namespace Helpers { export const value = /[)]/.test(')') }
    type Builder = typeof define;
    export type { Builder };
    export { type Output } from '../types';
    export interface Request { value: number }
    export default interface Response { value: number }
    ${definition};
  `
  expect((await parse(code)).map(({ channel }) => channel)).toStrictEqual([
    'run',
  ])
})

test('definition modules reject unsupported exports with a source location', async () => {
  for (const code of [
    'export const data = 1',
    'export default 1',
    'export let value = 1',
    'export function helper() {}',
    'export class Model {}',
    'export {} from "./side-effect"',
    'export * from "./other"',
    'export { value } from "./other"',
    'export import value = require("./other")',
    'export = value',
    'export const run = define(channel).inputValidator(schema).handler(fn)',
    'export const run = define(channel).handler(fn)',
    'export const run = define("run").handler()',
    'export const run = define("run").inputValidator(...schemas).handler(fn)',
    'export const run = define("run").inputValidator(schema, other).handler(fn)',
    'export const run = define("run").inputValidator(schema).handler()',
    'export const run = factory("run")',
  ])
    await expect(
      parse(
        header + `export const anchor = define('anchor').handler(fn); ` + code,
      ),
      code,
    ).rejects.toThrow(/test\.ipc\.ts:2:\d+: /)
})

test('ordinary modules, barrels and private IPC definitions remain ordinary', async () => {
  for (const code of [
    'export const value = 1; export default function ordinary() {}',
    'export * from "./definitions"; export { value } from "./ordinary"',
    `${header} const privateFn = define('private').handler(fn); export const ordinary = 1`,
    `${header} export const wrapper = (define: Function) => define('shadow').handler(fn)`,
    `const createIpcInvoke = () => ({handler: () => 1}); export const ordinary = createIpcInvoke().handler()`,
    `const define = () => {}; ${definition}`,
    `import type { createIpcInvoke as define } from 'electron-start'; ${definition}`,
    `import type { createIpcInvoke as define } from 'electron-start'; export type Builder = typeof define`,
  ])
    expect(
      (await analyzeIpcModule(code, '/ordinary.ts')).analysis,
      code,
    ).toEqual({ kind: 'ordinary' })
})

test('definition analysis is independent of filename and supports JS, JSX, TS and TSX', async () => {
  for (const extension of ['js', 'jsx', 'ts', 'tsx']) {
    const id = `/arbitrary.${extension}`
    const jsx = extension.endsWith('x') ? 'const view = <div />;' : ''
    expect(
      (
        await analyzeIpcModule(
          `${header}${jsx}export const run = define('channel').handler(fn)`,
          id,
        )
      ).analysis,
    ).toEqual({
      kind: 'definition',
      definitions: [
        { moduleKey: id, exportName: 'run', channel: 'channel', line: 2 },
      ],
    })
  }
  expect(
    (await analyzeIpcModule('declare export invalid', '/types.d.ts')).analysis,
  ).toEqual({ kind: 'ordinary' })
})

test('exported factory candidates trigger strict validation even when malformed', async () => {
  for (const declaration of [
    `export const run = define(channel).handler(fn)`,
    `export const run = define('').handler(fn)`,
    `export const run = define('x').handler()`,
    `export const run = define('x').inputValidator(...schemas).handler(fn)`,
    `export let run = define('x').handler(fn)`,
    `export default define('x').handler(fn)`,
    `const run = define('x').handler(fn); export { run }`,
  ])
    await expect(
      analyzeIpcModule(header + declaration, '/invalid.ts'),
      declaration,
    ).rejects.toThrow(/\/invalid.ts:2:\d+:/)
})
