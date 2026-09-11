import { expect, test } from 'vitest'
import { createRequire } from 'node:module'
import { ipcInvoke } from '#/vite'
import { fixture, bundle, ipcSource, entryCode, cjs, electronHarness, evaluate } from './helpers'

const require = createRequire(import.meta.url)
const valueModule = 'src/ipc/value.ipc.ts'
const entries = { 'renderer.ts': `export * from './src/ipc/value.ipc'`, 'main.ts': '', 'preload.ts': '' }

test('CommonJS main loads the published runtime through package exports', async (t) => {
  const root = await fixture(t, { ...entries,
    [valueModule]: ipcSource(`export const run = createIpcInvoke('external').inputValidator(z.string().transform(Number)).handler(({ data, event }) => ({ data, hasEvent: !!event }))`),
    'main.ts': `export { run } from './src/ipc/value.ipc'`,
  })
  const ipc = ipcInvoke()
  await bundle(root, ipc.renderer(), 'renderer.ts')
  const output = await bundle(root, ipc.main(), 'main.ts', {
    ...cjs(root, 'main.ts'), rolldownOptions: { external: ['electron', 'zod', 'electron-ipc-invoke'] },
  })
  const code = entryCode(output)
  expect(code).toMatch(/require\(["']electron-ipc-invoke["']\)/)
  const { electron, handlers } = electronHarness()
  const main = evaluate(code, electron, {}, {
    zod: require('zod'),
    'electron-ipc-invoke': require('electron-ipc-invoke'),
  })
  expect(structuredClone(await main.run('1'))).toStrictEqual({ data: 1, hasEvent: false })
  expect(structuredClone(await handlers.get('external')!({}, '2'))).toStrictEqual({ data: 2, hasEvent: true })
})

