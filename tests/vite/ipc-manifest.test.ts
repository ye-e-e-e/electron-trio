import fs from 'node:fs/promises'
import path from 'node:path'
import { createBuilder } from 'vite'
import { expect, test } from 'vitest'
import { electronTrio } from '#/vite'
import { electronHarness, evaluate, fixture, sourceAliases } from '../helpers'

test('production query imports share one manifest entry and one main implementation', async (t) => {
  const root = await fixture(t, {
    'renderer.ts': `export { run as desktop } from './functions.ts?variant=desktop'; export { run as mobile } from './functions.ts?variant=mobile'`,
    'functions.ts': `import { createIpcInvoke } from 'electron-trio'; let calls = 0; export const run = createIpcInvoke('run').handler(() => ++calls)`,
    'main.ts': '',
  })
  const builder = await createBuilder({
    root,
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: sourceAliases },
    plugins: [electronTrio({ entry: 'main.ts' })],
    environments: {
      client: {
        build: {
          lib: { entry: path.join(root, 'renderer.ts'), formats: ['es'] },
        },
      },
      electron_main: {
        build: {
          rolldownOptions: {
            output: { format: 'cjs', entryFileNames: 'main.cjs' },
          },
        },
      },
    },
  })
  await builder.buildApp()
  const { electron, handlers } = electronHarness()
  evaluate(
    await fs.readFile(path.join(root, 'dist/main/main.cjs'), 'utf8'),
    electron,
  )
  expect([...handlers.keys()]).toEqual(['run'])
  expect(await handlers.get('run')!({}, undefined)).toBe(1)
  expect(await handlers.get('run')!({}, undefined)).toBe(2)
})
