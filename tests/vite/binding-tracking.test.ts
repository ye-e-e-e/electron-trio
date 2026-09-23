import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { build, createServer } from 'vite'
import type { HotPayload, Plugin } from 'vite'
import { PluginContext } from '#/context/context'
import { mainPlugin, preloadPlugin, rendererPlugin } from '#/vite/plugin'
import { mainProxyPlugin } from '#/vite/main-proxy-plugin/plugin'
import { createIpcRuntime } from '#/runtime/ipc-runtime'
import { bundle, cjs, electronHarness, entryCode, evaluate, fixture, outputText, sourceAliases, until } from '../helpers'

const builder = (channel = 'configured', multiplier = 1) => `
  import { define } from './factory'
  import { z } from 'zod'
  export const configured = define(${JSON.stringify(channel)}).inputValidator(z.number().transform(value => value * ${multiplier}))
`
const files = {
  'factory.ts': `import * as ipc from 'electron-ipc-invoke'; export const define = ipc.createIpcInvoke`,
  'builder.ts': builder(),
  'barrel.ts': `export { define as factory } from './factory'; export * from './builder'`,
  'definitions.ts': `
    import * as ipc from 'electron-ipc-invoke'
    import { factory, configured } from '@factories'
    export const direct = ipc.createIpcInvoke('direct').handler(() => 'MAIN_ONLY_DIRECT')
    export const renamed = factory('renamed').handler(() => 'MAIN_ONLY_RENAMED')
    export const validated = configured.handler(({ data }) => 'MAIN_ONLY_VALUE:' + data)
  `,
  'renderer.ts': `export * from './definitions'`,
  'main.ts': `export * from './definitions'`,
  'preload.ts': '',
}
const aliases = (root: string): Plugin => ({
  name: 'test:factory-alias',
  config() { return { resolve: { alias: [{ find: '@factories', replacement: path.join(root, 'barrel.ts') }] } } },
})

test('production follows factory and builder bindings and strips implementations from renderer and preload', async t => {
  const root = await fixture(t, files)
  const context = new PluginContext({})
  const renderer = await bundle(root, [aliases(root), rendererPlugin(context)], 'renderer.ts', cjs(root, 'renderer.ts'))
  expect(context.requireManifest().map(record => record.channel)).toEqual(['configured', 'direct', 'renamed'])
  const main = await bundle(root, [aliases(root), mainPlugin(context)], 'main.ts', cjs(root, 'main.ts'))
  const preload = await bundle(root, [aliases(root), preloadPlugin(context)], 'preload.ts', cjs(root, 'preload.ts'))
  for (const output of [renderer, preload]) expect(outputText(output)).not.toMatch(/MAIN_ONLY|zod|inputValidator|~standard/)
  const harness = electronHarness()
  evaluate(entryCode(main), harness.electron)
  evaluate(entryCode(preload), harness.electron)
  const api = evaluate(entryCode(renderer), {}, { __ipc: harness.bridges.get('__ipc') })
  expect(await api.direct()).toBe('MAIN_ONLY_DIRECT')
  expect(await api.renamed()).toBe('MAIN_ONLY_RENAMED')
  expect(await api.validated(3)).toBe('MAIN_ONLY_VALUE:3')
  await expect(api.validated('3')).rejects.toThrow()
})

test.for(['serve', 'build'] as const)('preload rejects a handler defined through an imported builder in %s', async (command, t) => {
  const root = await fixture(t, { ...files, 'preload.ts': `import './definitions'` })
  const context = new PluginContext({})
  context.command = command
  if (command === 'build') context.publishManifest([])
  await expect(bundle(root, [aliases(root), preloadPlugin(context)], 'preload.ts'))
    .rejects.toThrow('Do not import IPC implementation modules into preload')
})

test('a preceding plugin cannot change a builder channel after the renderer manifest was produced', async t => {
  const root = await fixture(t, files)
  const context = new PluginContext({})
  await bundle(root, [aliases(root), rendererPlugin(context)], 'renderer.ts')
  await expect(bundle(root, [aliases(root), {
    name: 'test:change-builder', enforce: 'pre',
    transform(code, id) { if (id.endsWith('/builder.ts')) return code.replace('"configured"', '"different"') },
  }, mainPlugin(context)], 'main.ts')).rejects.toThrow('A preceding plugin changed IPC exports through')
})

test('creating a missing factory dependency recovers before any implementation was loaded', async t => {
  const root = await fixture(t, files)
  const context = new PluginContext({})
  const builderFile = path.join(root, 'builder.ts')
  let updates = 0
  const server = await createServer({
    root, configFile: false, logLevel: 'silent', resolve: { alias: sourceAliases },
    plugins: [aliases(root), rendererPlugin(context), {
      name: 'test:observe-provider', enforce: 'post',
      hotUpdate(update) { if (this.environment.name === 'ipc_invoke' && update.file === builderFile) updates++ },
    }],
    server: { middlewareMode: true, ws: false }, optimizeDeps: { noDiscovery: true },
  })
  t.onTestFinished(() => server.close())
  await server.transformRequest('/definitions.ts')
  const runtime = await createIpcRuntime(await context.devConnection!)
  t.onTestFinished(() => runtime.close())
  const target = { caller: 'renderer' as const, moduleKey: path.join(root, 'definitions.ts'), exportName: 'validated' }
  const invoke = () => runtime.invoke(target, undefined, 3)
  await fs.writeFile(builderFile, builder().replace('./factory', './missing-factory'))
  await until(() => updates > 0, 'missing factory analysis')
  await expect(invoke()).rejects.toThrow()
  expect(server.environments.ipc_invoke.moduleGraph.idToModuleMap.size).toBe(0)
  await fs.writeFile(path.join(root, 'missing-factory.ts'), `export { createIpcInvoke as define } from 'electron-ipc-invoke'`)
  await until(async () => { try { return await invoke() === 'MAIN_ONLY_VALUE:3' } catch { return false } }, 'missing factory recovery')
})

test.for(['main', 'renderer'] as const)('development refreshes imported builders for %s callers before the first invocation and after errors', async (caller, t) => {
  const root = await fixture(t, files)
  const key = path.join(root, 'definitions.ts')
  const builderFile = path.join(root, 'builder.ts')
  const context = new PluginContext({})
  const refreshed = new Set<string>()
  const server = await createServer({
    root, configFile: false, logLevel: 'silent', plugins: [aliases(root), rendererPlugin(context), {
      name: 'test:observe-renderer', enforce: 'post',
      hotUpdate(update) { if (this.environment.name === 'client') refreshed.add(update.file) },
    }],
    resolve: { alias: sourceAliases }, server: { middlewareMode: true, ws: false }, optimizeDeps: { noDiscovery: true },
  })
  t.onTestFinished(() => server.close())
  const messages: HotPayload[] = []
  vi.spyOn(server.environments.client.hot, 'send').mockImplementation(payload => { if (typeof payload !== 'string') messages.push(payload) })
  const runtime = await createIpcRuntime(await context.devConnection!)
  t.onTestFinished(() => runtime.close())
  let invoke: (input: number) => Promise<unknown>
  if (caller === 'renderer') {
    const transformed = await server.transformRequest('/definitions.ts')
    expect(transformed?.code).toContain('createDevRendererInvoker')
    expect(JSON.stringify(transformed)).not.toMatch(/MAIN_ONLY|inputValidator|zod/)
    invoke = input => runtime.invoke({ caller, moduleKey: key, exportName: 'validated' }, undefined, input)
  } else {
    const output = await bundle(root, [aliases(root), {
      name: 'test:runtime', enforce: 'pre',
      resolveId(id) { if (id === 'electron-ipc-invoke/dev') return '\0test:runtime' },
      load(id) { if (id === '\0test:runtime') return 'export const getRuntime = globalThis.__getRuntime' },
    }, mainProxyPlugin(context)], 'main.ts', cjs(root, 'main.ts'))
    expect(outputText(output)).not.toMatch(/MAIN_ONLY|inputValidator|zod/)
    const api = evaluate(entryCode(output), {}, { __getRuntime: async () => runtime })
    invoke = async input => api.validated(input)
  }
  const lookup = () => context.registry.lookup({ caller, moduleKey: key, exportName: 'validated' })
  refreshed.clear()
  await Promise.all([
    fs.writeFile(builderFile, builder('changed', 2)),
    fs.appendFile(path.join(root, 'factory.ts'), '\n// concurrent factory edit'),
  ])
  await until(() => refreshed.has(builderFile) && refreshed.has(path.join(root, 'factory.ts')), 'concurrent binding updates')
  await until(() => lookup().channel === 'changed', 'builder channel before first invocation')
  expect(await invoke(3)).toBe('MAIN_ONLY_VALUE:6')
  expect(messages).toEqual([])

  await fs.writeFile(builderFile, builder('changed').replace('"changed"', 'unknownChannel'))
  await until(async () => { try { await invoke(3); return false } catch { return true } }, 'invalid builder rejection')
  await fs.writeFile(builderFile, builder('restored', 3))
  await until(async () => { try { return await invoke(3) === 'MAIN_ONLY_VALUE:9' } catch { return false } }, 'builder repair')
  expect(lookup().channel).toBe('restored')

  await fs.unlink(builderFile)
  await until(async () => { try { await invoke(3); return false } catch { return true } }, 'deleted builder rejection')
  await fs.writeFile(builderFile, builder('recreated', 4))
  await until(async () => { try { return await invoke(3) === 'MAIN_ONLY_VALUE:12' } catch { return false } }, 'builder recreation')
  expect(lookup().channel).toBe('recreated')
})

test('production watch refreshes a proxy and manifest when only its imported builder changes', { timeout: 15000 }, async t => {
  const root = await fixture(t, files)
  const context = new PluginContext({})
  let output = ''
  let completed = 0
  const failures: Error[] = []
  const watcher = await build({
    root, configFile: false, logLevel: 'silent', resolve: { alias: sourceAliases },
    plugins: [aliases(root), rendererPlugin(context), {
      name: 'test:output', writeBundle(_options, bundle) {
        output = Object.values(bundle).filter(item => item.type === 'chunk').map(item => item.code).join('\n')
      },
    }],
    build: { watch: {}, outDir: 'out', minify: false, lib: { entry: path.join(root, 'renderer.ts'), formats: ['es'] } },
  })
  if (Array.isArray(watcher) || !('on' in watcher)) throw new Error('Expected a watcher')
  t.onTestFinished(() => watcher.close())
  watcher.on('event', event => {
    if (event.code === 'ERROR') failures.push(event.error)
    if (event.code === 'END') completed++
  })
  const ready = (channel: string, revision: number) => {
    if (failures.length) throw failures[0]
    try { return completed >= revision && context.requireManifest().some(record => record.channel === channel) && output.includes(channel) }
    catch { return false }
  }
  await until(() => ready('configured', 1), 'initial builder manifest')
  await fs.writeFile(path.join(root, 'builder.ts'), builder('updated-channel'))
  await until(() => ready('updated-channel', 2), 'updated builder manifest')
  expect(output).not.toMatch(/MAIN_ONLY|inputValidator|zod/)
  expect(context.requireManifest().map(record => record.channel)).toEqual(['direct', 'renamed', 'updated-channel'])
})
