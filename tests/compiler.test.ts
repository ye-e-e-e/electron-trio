import { expect, test } from 'vitest'
import { parseHandlers } from '#/internal/compiler'

const header = `import { createIpcInvoke as define } from 'electron-ipc-invoke';\n`
const definition = `export const run = define('run').inputValidator(schema).handler(fn)`
const parse = (code: string) => parseHandlers(code, 'test.ipc.ts')

test('top-level exports provide names, literal channels and source locations', () => {
  expect(parse(`// 😀中文\r\n${header}
    export const first = (define('😀中文').inputValidator(schema).handler(fn)),
      second = define('other').handler(fn);
  `)).toStrictEqual([
    { name: 'first', channel: '😀中文', file: 'test.ipc.ts', line: 4 },
    { name: 'second', channel: 'other', file: 'test.ipc.ts', line: 5 },
  ])
  expect(() => parse(header + 'export const run = ;')).toThrow(/test\.ipc\.ts:2:\d+: Unexpected token/)
})

test('private main code and type exports do not become IPC exports', () => {
  const code = `${header}
    const local = define('local').inputValidator(schema).handler(fn);
    const factory = (channel: string) => define(channel).inputValidator(schema).handler(fn);
    function helper(define: Function) { return define(1) }
    namespace Helpers { export const value = /[)]/.test(')') }
    type Builder = typeof define;
    export type { Builder };
    export { type Output } from './types';
    export interface Request { value: number }
    export default interface Response { value: number }
    ${definition};
  `
  expect(parse(code).map(({ channel }) => channel)).toStrictEqual(['run'])
})

test('unsupported exports fail with a source location instead of generating incorrect proxies', () => {
  for (const code of [
    'export const data = 1', 'export default 1', 'export let value = 1',
    'export {} from "./side-effect"', 'export * from "./other"',
    'export { value } from "./other"', 'export import value = require("./other")', 'export = value',
    'export const run = define(channel).inputValidator(schema).handler(fn)',
    'export const run = define(channel).handler(fn)',
    'export const run = define("run").handler()',
    'export const run = define("run").inputValidator(...schemas).handler(fn)',
    'export const run = define("run").inputValidator(schema, other).handler(fn)',
    'export const run = define("run").inputValidator(schema).handler()',
    'const alias = define; export const run = alias("run").inputValidator(schema).handler(fn)',
    'export const run = factory("run")',
  ]) expect(() => parse(header + code), code).toThrow(/test\.ipc\.ts:2:\d+: /)
  expect(() => parse(`const define = () => {}; ${definition}`)).toThrow(/Import createIpcInvoke/)
  expect(() => parse(`import type { createIpcInvoke as define } from 'electron-ipc-invoke'; ${definition}`)).toThrow(/Import createIpcInvoke/)
})
