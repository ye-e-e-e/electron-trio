import path from 'node:path'
import { expect, test, vi } from 'vitest'
import type { TestContext } from 'vitest'
import { PluginContext } from '#/context/context'
import { mainProxyPlugin } from '#/vite/main-proxy-plugin/plugin'
import type { IpcRuntime } from '#/runtime/ipc-runtime'
import { bundle, cjs, entryCode, evaluate, fixture } from '../helpers'

async function buildMain(t: TestContext, entry: string, files: Record<string, string> = {}) {
  const root = await fixture(t, {
    'definitions.ts': "import { createIpcInvoke } from 'electron-ipc-invoke'; export const old = createIpcInvoke('old').handler(() => 'not bundled')",
    'ordinary.ts': 'export const ordinary = 42',
    'barrel.ts': 'export * from "./definitions"; export * from "./ordinary"',
    'main.ts': entry,
    ...files,
  })
  const context = new PluginContext({})
  context.command = 'serve'
  let current: Record<string, (input?: unknown) => unknown> = { old: () => 'v1' }
  const runtime: Pick<IpcRuntime, 'invoke'> = {
    invoke: async (target, _event, input) => {
      if (target.caller !== 'main') throw new Error('main only')
      const fn = current[target.exportName]
      if (!fn) throw new Error(`Missing export ${target.exportName}`)
      return fn(input)
    },
  }
  const output = await bundle(root, [{
    name: 'test:main-runtime', enforce: 'pre',
    resolveId(id) { if (id === 'electron-ipc-invoke/dev') return '\0test:main-runtime' },
    load(id) { if (id === '\0test:main-runtime') return 'export const getRuntime = globalThis.__getRuntime' },
  }, mainProxyPlugin(context)], 'main.ts', { ...cjs(root, 'main.ts'), rolldownOptions: { external: ['node:path'] } })
  const ordinaryLoaded = vi.fn()
  const globals = { __getRuntime: async () => runtime, __ordinaryLoaded: ordinaryLoaded }
  const modules: Record<string, unknown> = { 'node:path': path }
  for (const chunk of output) if (chunk.type === 'chunk' && !chunk.isEntry) {
    let exports: unknown
    Object.defineProperty(modules, './' + chunk.fileName, {
      get: () => exports ??= evaluate(chunk.code, {}, globals, modules),
    })
  }
  const code = entryCode(output)
  return {
    exports: evaluate<Record<string, (...args: any[]) => any>>(code, {}, globals, modules),
    update(value: typeof current) { current = value }, ordinaryLoaded, code,
  }
}

test('main namespace exports stay fixed while existing function proxies use the latest implementation', async t => {
  const app = await buildMain(t, 'import * as ns from "./definitions"; export const get = () => ns')
  const ns = app.exports.get()
  const old = ns.old
  expect(await old()).toBe('v1')
  app.update({ old: () => 'v2', added: () => 2 })
  expect(ns.old).toBe(old)
  expect(await old()).toBe('v2')
  expect(Object.keys(ns)).toEqual(['old'])
  expect(ns.added).toBeUndefined()
  app.update({ added: () => 3 })
  expect(Object.keys(ns)).toEqual(['old'])
  await expect(old()).rejects.toThrow('Missing export old')
  expect(app.code).not.toContain('not bundled')
})

test('IPC exports can use runtime helper names without shadowing the generated import', async t => {
  const names = ['getRuntime', '__getRuntime', '__getRuntime_']
  const app = await buildMain(t, 'export * from "./definitions"', {
    'definitions.ts': `import { createIpcInvoke } from 'electron-ipc-invoke';\n` + names.map(name =>
      `export const ${name} = createIpcInvoke(${JSON.stringify(name)}).handler(() => 'not bundled')`).join('\n'),
  })
  app.update(Object.fromEntries(names.map(name => [name, (input: unknown) => [name, input]])))
  for (const name of names) expect(await app.exports[name](42)).toEqual([name, 42])
})

test.for([
  'import { old } from "./barrel"; export const get = () => old',
  'import * as ns from "./barrel"; export const get = () => ns.old',
  'import { group } from "./nested"; export const get = () => group.old',
  'export const get = async () => (await import("./barrel")).old',
])('ordinary import and reexport syntax retains function proxies: %s', async (entry, t) => {
  const app = await buildMain(t, entry, { 'nested.ts': 'export * as group from "./barrel"' })
  const old = await app.exports.get()
  expect(await old()).toBe('v1')
  app.update({ old: () => 'v2' })
  expect(await old()).toBe('v2')
  expect(await app.exports.get()).toBe(old)
})

test('ordinary explicit exports keep precedence over IPC star exports', async t => {
  const app = await buildMain(t, 'import * as ns from "./barrel"; export const get = () => ns', {
    'barrel.ts': 'export * from "./definitions"; export { join as old } from "node:path"; export const ordinary = 42',
  })
  const ns = app.exports.get()
  expect(ns.old).toBe(path.join)
  app.update({ old: () => 'v2', ordinary: () => 'new IPC export' })
  expect(ns.old).toBe(path.join)
  expect(ns.ordinary).toBe(42)
})

test('dynamic barrel imports keep ordinary dependency initialization lazy', async t => {
  const app = await buildMain(t, 'export const get = () => import("./barrel")', {
    'ordinary.ts': 'globalThis.__ordinaryLoaded(); export const ordinary = 42',
  })
  expect(app.ordinaryLoaded).not.toHaveBeenCalled()
  const ns = await app.exports.get()
  expect(app.ordinaryLoaded).toHaveBeenCalledTimes(1)
  expect(ns.ordinary).toBe(42)
  expect(await ns.old()).toBe('v1')
  app.update({ old: () => 'v2' })
  expect(await ns.old()).toBe('v2')
})
