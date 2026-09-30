import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createBuilder } from 'vite'
import { expect, test, vi } from 'vitest'
import { fixture, electronHarness, evaluate } from '../helpers'

test(
  'the packed archive builds all environments and ships a private bootstrap',
  { timeout: 30000 },
  async (t) => {
    const root = await fixture(t, {
      'package.json': '{"name":"isolated-consumer","type":"module"}',
      'definition.ts': `import { createIpcInvoke } from 'electron-start'; export const run = createIpcInvoke('packed').handler(() => 'PACKED_IMPLEMENTATION')`,
      'renderer.ts': `export { run } from './definition'`,
      'main.ts': `export { run } from './definition'; export { default as preload } from './preload'`,
      'bundled-main.ts': `export { loadWindow } from 'electron-start'`,
      'index.html': '<title>Packed renderer</title>',
      'preload.ts': `import { createPreload } from 'electron-start'; export default createPreload(() => {})`,
    })
    const command = promisify(execFile)
    const archive = path.join(root, 'package.tgz')
    await command('pnpm', ['pack', '--out', archive], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { ...process.env, npm_config_ignore_scripts: 'true', HUSKY: '0' },
    })
    const installed = path.join(root, 'node_modules/electron-start')
    await fs.mkdir(installed, { recursive: true })
    await command('tar', [
      '-xzf',
      archive,
      '--strip-components=1',
      '-C',
      installed,
    ])
    const consumerRequire = createRequire(path.join(root, 'consumer.cjs'))
    const metadata = JSON.parse(
      await fs.readFile(path.join(installed, 'package.json'), 'utf8'),
    )
    expect(Object.keys(metadata.exports).sort()).toEqual([
      '.',
      './package.json',
      './vite',
    ])
    for (const subpath of ['.', './vite']) {
      const specifier =
        subpath === '.'
          ? 'electron-start'
          : 'electron-start/' + subpath.slice(2)
      const entry = consumerRequire.resolve(specifier)
      expect(entry.startsWith(installed + path.sep)).toBe(true)
      expect(entry).toBe(path.resolve(installed, metadata.exports[subpath]))
      await fs.access(entry.replace(/\.mjs$/, '.d.mts'))
    }
    for (const specifier of [
      'electron-start/dev',
      'electron-start/electron',
      'electron-start/bootstrap',
    ]) {
      expect(() => consumerRequire.resolve(specifier)).toThrow(
        expect.objectContaining({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }),
      )
    }
    await expect(fs.access(path.join(installed, 'src'))).rejects.toThrow()
    const { electronStart } = await import(
      pathToFileURL(consumerRequire.resolve('electron-start/vite')).href
    )
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [electronStart({ entry: 'main.ts' })],
      build: {
        minify: false,
        lib: {
          entry: path.join(root, 'renderer.ts'),
          formats: ['cjs'],
          fileName: () => 'renderer.cjs',
        },
      },
      environments: {
        electron_main: {
          build: {
            rolldownOptions: {
              external: ['electron', 'electron-start'],
              output: { format: 'cjs', entryFileNames: 'main.cjs' },
            },
          },
        },
      },
    })
    await builder.buildApp()
    const renderer = await fs.readFile(
      path.join(root, 'dist/client/renderer.cjs'),
      'utf8',
    )
    const main = await fs.readFile(
      path.join(root, 'dist/main/main.cjs'),
      'utf8',
    )
    const preloadFile = (
      await fs.readdir(path.join(root, 'dist/preload'))
    ).find((file) => file.startsWith('preload-') && file.endsWith('.cjs'))!
    const preload = await fs.readFile(
      path.join(root, 'dist/preload', preloadFile),
      'utf8',
    )
    expect(renderer + preload).not.toContain('PACKED_IMPLEMENTATION')
    expect(main + preload + renderer).not.toMatch(
      /ModuleRunner|WebSocket|virtual:electron-start:ipc-dispatcher/,
    )
    expect(main).toMatch(/require\(["']electron-start["']\)/)
    const harness = electronHarness()
    const api = evaluate(
      main,
      harness.electron,
      { __dirname: path.join(root, 'dist/main') },
      {
        'electron-start': consumerRequire('electron-start'),
        'node:path': path,
      },
    )
    evaluate(preload, harness.electron)
    const client = evaluate(
      renderer,
      {},
      { __ipc: harness.bridges.get('__ipc') },
    )
    expect(await api.run()).toBe('PACKED_IMPLEMENTATION')
    expect(await client.run()).toBe('PACKED_IMPLEMENTATION')
    const bundledBuilder = await createBuilder({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [electronStart({ entry: 'bundled-main.ts' })],
      build: { outDir: 'bundled-output' },
      environments: {
        electron_main: {
          build: {
            minify: true,
            rolldownOptions: {
              output: { format: 'cjs', entryFileNames: 'main.cjs' },
            },
          },
        },
      },
    })
    await bundledBuilder.buildApp()
    const bundledMainDirectory = path.join(root, 'bundled-output/main')
    const bundledMain = await fs.readFile(
      path.join(bundledMainDirectory, 'main.cjs'),
      'utf8',
    )
    const bundledApi = evaluate(
      bundledMain,
      harness.electron,
      { __dirname: bundledMainDirectory, process: { env: {} } },
      { 'node:path': path },
    )
    const loadFile = vi.fn().mockResolvedValue(undefined)
    await bundledApi.loadWindow({ loadFile })
    expect(loadFile).toHaveBeenCalledExactlyOnceWith(
      path.join(root, 'bundled-output/client/index.html'),
    )
    const boot = await fs.readFile(
      path.join(
        path.dirname(consumerRequire.resolve('electron-start/package.json')),
        'dist/bootstrap.mjs',
      ),
      'utf8',
    )
    expect(boot).toContain('vite/module-runner')
    expect(boot).not.toMatch(/from ["']vite["']/)
  },
)
