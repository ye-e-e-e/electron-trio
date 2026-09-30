import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBuilder } from 'vite'
import { expect, test, vi } from 'vitest'
import { electronStart } from '#/vite'
import { fixture, sourceAliases } from '../helpers'

test.for([
  { format: 'es', outDir: 'dist', client: 'dist/client', main: 'dist/main' },
  {
    format: 'cjs',
    outDir: 'output',
    client: 'output/web space',
    main: 'output/app',
  },
] as const)(
  'loadWindow follows renderer output paths after relocating a $format build ($client)',
  async ({ format, outDir, client, main }, t) => {
    vi.stubEnv('VITE_DEV_SERVER_URL', undefined)
    t.onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const root = await fixture(t, {
      'index.html': '<title>Renderer</title>',
      'main.ts': `export { loadWindow } from 'electron-start'`,
      'node_modules/electron/package.json': JSON.stringify({
        name: 'electron',
        main: 'index.cjs',
      }),
      'node_modules/electron/index.cjs':
        'exports.ipcMain = { handle() {}, removeHandler() {} }',
    })
    const extension = format === 'es' ? 'mjs' : 'cjs'
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: 'silent',
      resolve: { alias: sourceAliases },
      plugins: [electronStart({ entry: 'main.ts' })],
      build: { outDir },
      environments: {
        ...(client !== `${outDir}/client`
          ? { client: { build: { outDir: client } } }
          : {}),
        electron_main: {
          build: {
            ...(main !== `${outDir}/main` ? { outDir: main } : {}),
            rolldownOptions: {
              output: { format, entryFileNames: `nested/main.${extension}` },
            },
          },
        },
      },
    })
    await builder.buildApp()
    const relocated = path.join(root, 'relocated')
    await fs.rename(path.join(root, outDir), relocated)
    const mainFile = path.join(
      relocated,
      path.relative(outDir, main),
      `nested/main.${extension}`,
    )
    const exports =
      format === 'es'
        ? await import(pathToFileURL(mainFile).href)
        : createRequire(import.meta.url)(mainFile)
    const expected = path.join(
      relocated,
      path.relative(outDir, client),
      'index.html',
    )
    const loadFile = vi.fn().mockResolvedValue(undefined)
    await exports.loadWindow({ loadFile })
    expect(loadFile).toHaveBeenCalledExactlyOnceWith(expected)
    expect(await fs.readFile(expected, 'utf8')).toContain('Renderer')
  },
)
