import { expect, test } from 'vitest'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { ipcInvoke } from 'electron-ipc-invoke/vite'
import fs from 'node:fs/promises'
import { fixture, bundle, ipcSource, entryCode, outputText, cjs, electronHarness, evaluate } from '../helpers'

const require = createRequire(import.meta.url)
const valueModule = 'src/ipc/value.ts'
const entries = { 'renderer.ts': `export * from './src/ipc/value'`, 'main.ts': '', 'preload.ts': '' }

test('CommonJS main loads the published runtime through package exports', async (t) => {
  const root = await fixture(t, { ...entries,
    [valueModule]: ipcSource(`export const run = createIpcInvoke('external').inputValidator(z.string().transform(Number)).handler(({ data, event }) => ({ data, hasEvent: !!event }))`),
    'main.ts': `export { run } from './src/ipc/value'`,
  })
  const [rendererPlugin, mainPlugin] = ipcInvoke()
  await bundle(root, rendererPlugin, 'renderer.ts')
  const output = await bundle(root, mainPlugin, 'main.ts', {
    ...cjs(root, 'main.ts'), rolldownOptions: { external: ['electron', 'zod', 'electron-ipc-invoke'] },
  })
  const code = entryCode(output)
  expect(outputText(output)).not.toMatch(/vite\/module-runner|electron-ipc-invoke\/dev|electron-ipc-invoke:runtime-barrier|WebSocket/)
  expect(code).toMatch(/require\(["']electron-ipc-invoke["']\)/)
  const { electron, handlers } = electronHarness()
  const main = evaluate(code, electron, {}, {
    zod: require('zod'),
    'electron-ipc-invoke': require('electron-ipc-invoke'),
  })
  expect(structuredClone(await main.run('1'))).toStrictEqual({ data: 1, hasEvent: false })
  expect(structuredClone(await handlers.get('external')!({}, '2'))).toStrictEqual({ data: 2, hasEvent: true })
})


for (const format of ['es', 'cjs'] as const) {
  test(`published development runtime resolves for ${format} main without importing the Vite server`, async t => {
    const runtimeFile = require.resolve('electron-ipc-invoke/dev')
    expect(runtimeFile).toMatch(/dist[\\/]dev\.mjs$/)
    const root = await fixture(t, {
      'consumer.ts': `export * from 'electron-ipc-invoke/dev'`,
    })
    const output = await bundle(root, [], 'consumer.ts', {
      lib: { entry: `${root}/consumer.ts`, formats: [format] },
      rolldownOptions: { external: ['electron', 'ws', 'vite/module-runner'] },
    })
    const code = entryCode(output)
    expect(output.find(item => item.type === 'chunk' && item.isEntry)).toMatchObject({ exports: ['getRuntime', 'initRuntime'] })
    expect(code).toContain('vite/module-runner')
    expect(code).not.toMatch(/(?:from\s*|require\()["']vite["']/)
    const published = await fs.readFile(runtimeFile, 'utf8')
    expect(published).not.toMatch(/(?:from\s*|import\()["']vite["']/)
  })
}

test('the packed archive installs all public entries and shared runtime chunks', { timeout: 30000 }, async t => {
  const root = await fixture(t, {
    'package.json': '{"name":"isolated-consumer","type":"module"}',
    'definition.ts': `import { createIpcInvoke } from 'electron-ipc-invoke'; export const run = createIpcInvoke('packed').handler(() => 'PACKED_IMPLEMENTATION')`,
    'renderer.ts': `export { run } from './definition'`,
    'main.ts': '',
    'preload.ts': '',
    'runtime-consumer.ts': `export * from 'electron-ipc-invoke/dev'`,
  })
  const command = promisify(execFile)
  const archive = path.join(root, 'package.tgz')
  await command('pnpm', ['pack', '--out', archive], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { ...process.env, npm_config_ignore_scripts: 'true', HUSKY: '0' },
  })
  const installed = path.join(root, 'node_modules/electron-ipc-invoke')
  await fs.mkdir(installed, { recursive: true })
  await command('tar', ['-xzf', archive, '--strip-components=1', '-C', installed])
  const consumerRequire = createRequire(path.join(root, 'consumer.cjs'))
  const metadata = JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8'))
  expect(metadata.exports).not.toHaveProperty('./renderer')
  expect(Object.keys(metadata.exports).sort()).toEqual(['.', './dev', './package.json', './vite'])
  for (const subpath of ['.', './vite', './dev']) {
    const specifier = subpath === '.' ? 'electron-ipc-invoke' : 'electron-ipc-invoke/' + subpath.slice(2)
    const entry = consumerRequire.resolve(specifier)
    expect(entry.startsWith(installed + path.sep)).toBe(true)
    expect(entry).toBe(path.resolve(installed, metadata.exports[subpath]))
    await fs.access(entry.replace(/\.mjs$/, '.d.mts'))
  }
  await expect(fs.access(path.join(installed, 'src'))).rejects.toThrow()
  const publishedPlugin = await import(pathToFileURL(consumerRequire.resolve('electron-ipc-invoke/vite')).href)
  const plugins = publishedPlugin.ipcInvoke() as import('electron-ipc-invoke/vite').IpcInvokePlugins
  for (const [index, target] of ['renderer', 'main', 'preload'].entries()) {
    const built = await build({
      root, configFile: false, logLevel: 'silent', plugins: [plugins[index]],
      build: { write: false, minify: false,
        lib: { entry: path.join(root, `${target}.ts`), formats: ['cjs'] },
        rolldownOptions: { external: ['electron'] },
      },
    })
    if (!Array.isArray(built) && !('output' in built)) throw new Error('Expected a completed packed consumer build')
    const output = (Array.isArray(built) ? built : [built]).flatMap(item => item.output)
    const code = entryCode(output)
    expect(code).not.toMatch(/vite\/module-runner|electron-ipc-invoke\/dev|WebSocket/)
    if (target === 'renderer') {
      expect(outputText(output)).not.toContain('PACKED_IMPLEMENTATION')
      const api = evaluate(code, {}, { __ipc: { packed: async () => 'BRIDGE_RESULT' } })
      expect(await api.run()).toBe('BRIDGE_RESULT')
    }
    if (target === 'main') {
      const harness = electronHarness()
      evaluate(code, harness.electron)
      expect(await harness.handlers.get('packed')!({}, undefined)).toBe('PACKED_IMPLEMENTATION')
    }
    if (target === 'preload') {
      const harness = electronHarness()
      evaluate(code, harness.electron)
      expect(Object.keys(harness.bridges.get('__ipc')!)).toEqual(['packed'])
    }
  }
  // Bundling resolves every relative runtime chunk from the extracted archive,
  // while Electron itself remains external and is validated by the Electron suite.
  const runtime = await build({
    root, configFile: false, logLevel: 'silent',
    build: { write: false, minify: false,
      lib: { entry: path.join(root, 'runtime-consumer.ts'), formats: ['es', 'cjs'] },
      rolldownOptions: { external: ['electron', 'ws', 'vite/module-runner'] },
    },
  })
  if (!Array.isArray(runtime)) throw new Error('Expected both runtime output formats')
  expect(runtime).toHaveLength(2)
  for (const output of runtime) {
    expect(output.output.find(item => item.type === 'chunk' && item.isEntry)).toMatchObject({ exports: ['getRuntime', 'initRuntime'] })
    expect(entryCode(output.output)).toContain('vite/module-runner')
    expect(entryCode(output.output)).not.toMatch(/(?:from\s*|require\()["']vite["']/)
  }
})
