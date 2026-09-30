import { expect, test } from 'vitest'
import { analyzePreloadEntry } from '#/compiler/preload-analyzer'

test.for([
  `import { createPreload as define } from 'electron-start'; export default define(() => 42)`,
  `import * as api from 'electron-start'; export default api.createPreload(() => 42)`,
  `import * as api from 'electron-start'; const define = api['createPreload']; const alias = define; export default alias(() => 42)`,
  `import { createPreload } from 'electron-start'; const define = createPreload as Factory; export default (define!(() => 42) satisfies string)`,
])(
  'recognizes a preload call through its imported symbol: %s',
  async (code) => {
    const analysis = await analyzePreloadEntry(code, '/preload.ts')
    expect(analysis).toBeDefined()
    expect(code.slice(analysis!.callback.start, analysis!.callback.end)).toBe(
      '() => 42',
    )
  },
)

test('does not recognize preload factories imported from another module', async () => {
  for (const code of [
    `import { createPreload } from './factory'; export default createPreload(() => {})`,
    `import * as api from './barrel'; export default api.createPreload(() => {})`,
    `import define from './factory'; export default define(() => {})`,
  ])
    expect(await analyzePreloadEntry(code, '/preload.ts')).toBeUndefined()
})

test('recognizes a direct factory without inspecting callback imports', async () => {
  const code = `import { createPreload } from 'electron-start'; import { setup } from './missing'; export default createPreload(setup)`
  const analysis = await analyzePreloadEntry(code, '/preload.ts')
  expect(analysis).toBeDefined()
  expect(code.slice(analysis!.callback.start, analysis!.callback.end)).toBe(
    'setup',
  )
})

test('factory helper exports and unrelated functions remain ordinary modules', async () => {
  for (const code of [
    `export { createPreload as define } from 'electron-start'`,
    `import * as api from 'electron-start'; export const define = api.createPreload`,
    `import { createPreload } from 'electron-start'; export default createPreload`,
    `const createPreload = callback => callback; export default createPreload(() => {})`,
    `import type { createPreload } from 'electron-start'; export default createPreload(() => {})`,
    `import { createIpcInvoke as createPreload } from 'electron-start'; export default createPreload(() => {})`,
  ])
    expect(await analyzePreloadEntry(code, '/helper.ts')).toBeUndefined()
})

test('preload entry constraints are applied after resolving the imported symbol', async () => {
  const header = `import * as api from 'electron-start'; const define = api.createPreload;\n`
  for (const code of [
    `export const preload = define(() => {})`,
    `const preload = define(() => {}); export default preload`,
    `export default define()`,
    `export default define(...callbacks)`,
    `export default define(() => {}, () => {})`,
    `export default define(() => {}); export const other = 1`,
  ])
    await expect(
      analyzePreloadEntry(header + code, '/preload.ts'),
    ).rejects.toThrow(/\/preload.ts:2:\d+:/)
})
