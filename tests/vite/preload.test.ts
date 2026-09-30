import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBuilder, createServer } from 'vite'
import type { HotPayload } from 'vite'
import { expect, test, vi } from 'vitest'
import type { ElectronDevEnvironment } from '#/vite/electron-plugin/environment'
import { electronPlugin } from '#/vite/electron-plugin/plugin'
import { DEV_CHANNEL } from '#/vite/ipc-entry-plugin/constants'
import { preloadPlugin } from '#/vite/preload-plugin/plugin'
import {
  evaluate,
  fetchRunner,
  fixture,
  fixtureWatch,
  sourceAliases,
  until,
} from '../helpers'

const options = { entry: 'main.ts' }
const configImports = `
  import fs from 'node:fs'
  import { electronPlugin } from ${JSON.stringify(path.resolve(import.meta.dirname, '../../src/vite/electron-plugin/plugin.ts'))}
  import { preloadPlugin } from ${JSON.stringify(path.resolve(import.meta.dirname, '../../src/vite/preload-plugin/plugin.ts'))}
`

test('preload imports build lazily, share a watcher and execute only in preload', async (t) => {
  const root = await fixture(t, {
    'main.ts': `import preload from './preload'; export { preload }; export { default as again } from './preload'`,
    'preload.ts': `import { createPreload as define } from 'electron-trio'; import { contextBridge } from 'electron'; import { value } from './value'; export default define(() => { contextBridge.exposeInMainWorld('value', value) })`,
    'unused.ts': `import { createPreload } from 'electron-trio'; export default createPreload(() => { throw new Error('unused') })`,
    'value.ts': `export const value = 'initial'`,
    'vite.config.ts': `${configImports}
      export default {
        logLevel: 'silent',
        plugins: [electronPlugin(${JSON.stringify(options)}), preloadPlugin(), {
          name: 'test:count-preload',
          writeBundle() { if (this.environment.name === 'electron_preload') fs.appendFileSync(new URL('./writes', import.meta.url), 'x') },
        }],
        environments: { electron_preload: { build: { watch: ${JSON.stringify(fixtureWatch)} } } },
      }`,
  })
  const writes = () =>
    fs.readFile(path.join(root, 'writes'), 'utf8').catch(() => '')
  const server = await createServer({ root })
  t.onTestFinished(() => server.close())
  const main = server.environments.electron_main
  const reload = vi.spyOn(
    (main as ElectronDevEnvironment).electron,
    'reloadWindows',
  )
  const restart = vi.spyOn((main as ElectronDevEnvironment).electron, 'restart')
  const hotSend = vi.spyOn(
    main.hot as { send(payload: HotPayload): void },
    'send',
  )
  const runner = fetchRunner(t, main)
  expect(await writes()).toBe('')
  await expect(fs.access(path.join(root, 'dist/preload'))).rejects.toThrow()
  const exports = await runner.import<{ preload: string; again: string }>(
    path.join(root, 'main.ts'),
  )
  expect(path.isAbsolute(exports.preload)).toBe(true)
  expect(exports.again).toBe(exports.preload)
  const preloadModule = main.moduleGraph.getModuleById(
    path.join(root, 'preload.ts'),
  )
  expect(preloadModule).toBeDefined()
  expect(preloadModule?.importedModules.size).toBe(0)
  expect(preloadModule?.isSelfAccepting).toBe(true)
  expect(
    main.moduleGraph.getModuleById(path.join(root, 'value.ts')),
  ).toBeUndefined()
  expect(await writes()).toBe('x')
  expect(reload).not.toHaveBeenCalled()
  const exposeInMainWorld = vi.fn()
  evaluate(await fs.readFile(exports.preload, 'utf8'), {
    contextBridge: { exposeInMainWorld },
  })
  expect(exposeInMainWorld).toHaveBeenCalledExactlyOnceWith('value', 'initial')
  await fs.writeFile(
    path.join(root, 'value.ts'),
    `export const value = 'updated'`,
  )
  await until(
    async () => (await writes()) === 'xx' && reload.mock.calls.length === 1,
    'preload dependency update',
  )
  exposeInMainWorld.mockClear()
  evaluate(await fs.readFile(exports.preload, 'utf8'), {
    contextBridge: { exposeInMainWorld },
  })
  expect(exposeInMainWorld).toHaveBeenCalledExactlyOnceWith('value', 'updated')
  hotSend.mockClear()
  await fs.writeFile(
    path.join(root, 'preload.ts'),
    `import { createPreload } from 'electron-trio'; import { contextBridge } from 'electron'; import { value } from './value'; export default createPreload(() => contextBridge.exposeInMainWorld('value', value + ':entry'))`,
  )
  await until(
    async () =>
      (await writes()) === 'xxx' &&
      reload.mock.calls.length === 2 &&
      hotSend.mock.calls.some(
        ([payload]) =>
          typeof payload !== 'string' &&
          payload.type === 'update' &&
          payload.updates.some(
            (update) => update.acceptedPath === preloadModule?.url,
          ),
      ),
    'preload entry rebuild and self-accepting main path update',
  )
  expect(restart).not.toHaveBeenCalled()
  const refreshed = await runner.import<{ default: string }>(
    path.join(root, 'preload.ts'),
  )
  expect(refreshed.default).toBe(exports.preload)
  exposeInMainWorld.mockClear()
  evaluate(await fs.readFile(exports.preload, 'utf8'), {
    contextBridge: { exposeInMainWorld },
  })
  expect(exposeInMainWorld).toHaveBeenCalledExactlyOnceWith(
    'value',
    'updated:entry',
  )
})

test(
  'one development builder isolates concurrent preload entries and their watch updates',
  { timeout: 30000 },
  async (t) => {
    const source = (label: string) => `
    import { createPreload } from 'electron-trio'
    import { contextBridge } from 'electron'
    import { value } from './value'
    import { shared } from '../shared'
    export default createPreload(() => contextBridge.exposeInMainWorld('value', { label: '${label}', value, shared }))
  `
    const root = await fixture(t, {
      'main.ts': '',
      'first.ts': `export { default } from './first/preload'`,
      'second.ts': `export { default } from './second/preload'`,
      'again.ts': `export { default } from './first/preload'`,
      'first/preload.ts': source('first'),
      'first/value.ts': `export const value = 1`,
      'second/preload.ts': source('second'),
      'second/value.ts': `export const value = 10`,
      'shared.ts': `export const shared = 'initial'`,
      'vite.config.ts': `
      import fs from 'node:fs'
      import { randomUUID } from 'node:crypto'
      import { electronTrio } from ${JSON.stringify(path.resolve(import.meta.dirname, '../../src/vite.ts'))}
      export default ({ command, mode }) => {
        const instance = randomUUID()
        const environments = new WeakMap()
        const environmentId = environment => {
          if (!environments.has(environment)) environments.set(environment, randomUUID())
          return environments.get(environment)
        }
        const record = (file, data) => fs.appendFileSync(new URL(file, import.meta.url), JSON.stringify(data) + '\\n')
        record('./configs.jsonl', { command, mode, instance })
        return {
          logLevel: 'silent',
          plugins: [electronTrio({ entry: 'main.ts', bridgeName: 'desktop' }), {
            name: 'test:preload-environments',
            applyToEnvironment: environment => environment.name === 'electron_preload',
            transform: { order: 'pre', async handler(_code, id) {
              if (id.endsWith('/first/preload.ts')) await new Promise(resolve => setTimeout(resolve, 40))
            } },
            writeBundle(_options, bundle) {
              const entry = Object.values(bundle).find(item => item.type === 'chunk' && item.isEntry)
              record('./builds.jsonl', { instance, environment: environmentId(this.environment), entry: entry.facadeModuleId })
            },
            closeWatcher() { record('./closed.jsonl', environmentId(this.environment)) },
          }],
          environments: { electron_preload: { build: { watch: ${JSON.stringify(fixtureWatch)} } } },
        }
      }`,
    })
    const records = async (file: string) =>
      (await fs.readFile(path.join(root, file), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    const server = await createServer({ root })
    t.onTestFinished(() => server.close())
    const configs = await records('configs.jsonl')
    expect(configs.map(({ command, mode }) => [command, mode])).toEqual([
      ['serve', 'development'],
      ['build', 'development'],
    ])
    await expect(fs.access(path.join(root, 'dist/preload'))).rejects.toThrow()
    const runner = fetchRunner(t, server.environments.electron_main)
    const [first, second, again] = await Promise.all(
      ['first', 'second', 'again'].map(
        async (name) =>
          (
            await runner.import<{ default: string }>(
              path.join(root, `${name}.ts`),
            )
          ).default,
      ),
    )
    expect(first).not.toBe(second)
    expect(again).toBe(first)
    const initial = await records('builds.jsonl')
    expect(initial).toHaveLength(2)
    expect(new Set(initial.map((item) => item.instance))).toEqual(
      new Set([configs[1].instance]),
    )
    expect(new Set(initial.map((item) => item.environment)).size).toBe(2)
    const byEntry = new Map(
      initial.map((item) => [item.entry, item.environment]),
    )
    let completedBuilds = initial
    const waitForBuilds = async (...entries: string[]) => {
      let nextBuilds = completedBuilds
      // Read outputs after writeBundle, rather than while a watcher is rewriting them.
      await until(
        async () => {
          nextBuilds = await records('builds.jsonl')
          return entries.every((entry) => {
            const id = path.join(root, entry, 'preload.ts')
            return (
              nextBuilds.filter((item) => item.entry === id).length >
              completedBuilds.filter((item) => item.entry === id).length
            )
          })
        },
        `preload builds: ${entries.join(', ')}`,
      )
      completedBuilds = nextBuilds
    }
    const read = async (file: string) => {
      const bridges = new Map<string, any>()
      const invoke = vi.fn()
      evaluate(await fs.readFile(file, 'utf8'), {
        contextBridge: {
          exposeInMainWorld(name: string, bridge: unknown) {
            bridges.set(name, bridge)
          },
        },
        ipcRenderer: { invoke },
      })
      expect([...bridges.keys()].sort()).toEqual(['desktop', 'value'])
      bridges.get('desktop').invoke('/functions.ts', 'run', 42)
      expect(invoke).toHaveBeenCalledExactlyOnceWith(
        DEV_CHANNEL,
        '/functions.ts',
        'run',
        42,
      )
      return bridges.get('value')
    }
    expect(await read(first)).toEqual({
      label: 'first',
      value: 1,
      shared: 'initial',
    })
    expect(await read(second)).toEqual({
      label: 'second',
      value: 10,
      shared: 'initial',
    })

    await fs.writeFile(
      path.join(root, 'first/value.ts'),
      `export const value = 2`,
    )
    await waitForBuilds('first')
    expect(await read(first)).toEqual({
      label: 'first',
      value: 2,
      shared: 'initial',
    })
    expect(await read(second)).toEqual({
      label: 'second',
      value: 10,
      shared: 'initial',
    })
    expect(
      (await records('builds.jsonl')).filter((item) =>
        item.entry.endsWith('/second/preload.ts'),
      ),
    ).toHaveLength(1)

    await Promise.all([
      fs.writeFile(
        path.join(root, 'first/preload.ts'),
        source('first-updated'),
      ),
      fs.writeFile(
        path.join(root, 'second/preload.ts'),
        source('second-updated'),
      ),
    ])
    await waitForBuilds('first', 'second')
    expect(await read(first)).toEqual({
      label: 'first-updated',
      value: 2,
      shared: 'initial',
    })
    expect(await read(second)).toEqual({
      label: 'second-updated',
      value: 10,
      shared: 'initial',
    })
    await fs.writeFile(
      path.join(root, 'shared.ts'),
      `export const shared = 'updated'`,
    )
    await waitForBuilds('first', 'second')
    expect(await read(first)).toEqual({
      label: 'first-updated',
      value: 2,
      shared: 'updated',
    })
    expect(await read(second)).toEqual({
      label: 'second-updated',
      value: 10,
      shared: 'updated',
    })

    const previousSecond = await fs.readFile(second, 'utf8')
    await Promise.all([
      fs.writeFile(path.join(root, 'first/value.ts'), `export const value = 3`),
      fs.writeFile(
        path.join(root, 'second/value.ts'),
        `export const value = @invalid`,
      ),
    ])
    await waitForBuilds('first')
    expect(await read(first)).toEqual({
      label: 'first-updated',
      value: 3,
      shared: 'updated',
    })
    expect(await fs.readFile(second, 'utf8')).toBe(previousSecond)
    await fs.writeFile(
      path.join(root, 'second/value.ts'),
      `export const value = 11`,
    )
    await waitForBuilds('second')
    expect(await read(first)).toEqual({
      label: 'first-updated',
      value: 3,
      shared: 'updated',
    })
    expect(await read(second)).toEqual({
      label: 'second-updated',
      value: 11,
      shared: 'updated',
    })
    expect(await records('configs.jsonl')).toEqual(configs)
    for (const item of await records('builds.jsonl')) {
      expect(item.instance).toBe(configs[1].instance)
      expect(item.environment).toBe(byEntry.get(item.entry))
    }
    await server.close()
    expect((await records('closed.jsonl')).sort()).toEqual(
      [...byEntry.values()].sort(),
    )
  },
)

test.for(['es', 'cjs'] as const)(
  'production %s imports expose relocatable paths for separate preload entries',
  async (format, t) => {
    const root = await fixture(t, {
      'index.html': '',
      'main.ts': `#!/usr/bin/env node\nexport { default as first } from './one/preload'; export { default as second } from './two/preload'`,
      'one/preload.ts': `import { createPreload } from 'electron-trio'; export default createPreload(() => { globalThis.first = true })`,
      'two/preload.ts': `import { createPreload } from 'electron-trio'; export default createPreload(() => { globalThis.second = true })`,
    })
    const extension = format === 'es' ? 'mjs' : 'cjs'
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: 'silent',
      resolve: { alias: sourceAliases },
      plugins: [electronPlugin(options), preloadPlugin()],
      environments: {
        electron_main: {
          build: {
            outDir: 'output/main',
            rolldownOptions: {
              output: { format, entryFileNames: `main.${extension}` },
            },
          },
        },
        electron_preload: {
          build: {
            outDir: 'output/preload space',
            rolldownOptions: { treeshake: false, external: ['electron-trio'] },
          },
        },
      },
    })
    await builder.buildApp()
    const directory = path.join(root, 'relocated')
    await fs.rename(path.join(root, 'output'), directory)
    const mainFile = path.join(directory, `main/main.${extension}`)
    const exports =
      format === 'es'
        ? await import(pathToFileURL(mainFile).href)
        : createRequire(import.meta.url)(mainFile)
    expect(exports.first).not.toBe(exports.second)
    for (const key of ['first', 'second']) {
      expect(exports[key].startsWith(directory + path.sep)).toBe(true)
      const globals: Record<string, unknown> = {}
      evaluate(
        await fs.readFile(exports[key], 'utf8'),
        {},
        { globalThis: globals },
      )
      expect(globals).toEqual({ [key]: true })
    }
    expect(await fs.readFile(mainFile, 'utf8')).not.toContain(
      'globalThis.first',
    )
    expect(await fs.readFile(mainFile, 'utf8')).toMatch(
      /^#!\/usr\/bin\/env node\n/,
    )
  },
)

test.for(['development', 'production'] as const)(
  'shared symbol resolution compiles preload namespaces and local aliases in %s',
  async (mode, t) => {
    const root = await fixture(t, {
      'index.html': '',
      'main.ts': `export { default as namespace } from './namespace'; export { default as alias } from './alias'`,
      'namespace.ts': `import * as api from 'electron-trio'; const define = api['createPreload']; export default define(() => { globalThis.value = 'namespace' })`,
      'alias.ts': `import { createPreload as factory } from 'electron-trio'; import { value } from './value'; import './effects'; const define = factory; export default define(() => { globalThis.value = value })`,
      'effects.ts': `globalThis.helperLoads = (globalThis.helperLoads ?? 0) + 1`,
      'value.ts': `export const value = 'alias'`,
      'vite.config.ts': `${configImports}
      export default {
        logLevel: 'silent',
        plugins: [electronPlugin(${JSON.stringify(options)}), preloadPlugin()],
        environments: {
          electron_main: { build: { rolldownOptions: { output: { format: 'cjs', entryFileNames: 'main.cjs' } } } },
          electron_preload: { build: { rolldownOptions: { external: ['electron-trio'] }, watch: ${JSON.stringify(fixtureWatch)} } },
        },
      }`,
    })
    let paths: { namespace: string; alias: string }
    if (mode === 'development') {
      const server = await createServer({ root })
      t.onTestFinished(() => server.close())
      paths = await fetchRunner(t, server.environments.electron_main).import(
        path.join(root, 'main.ts'),
      )
    } else {
      const builder = await createBuilder({ root })
      await builder.buildApp()
      paths = createRequire(import.meta.url)(
        path.join(root, 'dist/main/main.cjs'),
      )
    }
    const read = async (file: string) => {
      const code = await fs.readFile(file, 'utf8')
      expect(code).not.toMatch(/require\(["']electron-trio["']\)/)
      const globals: Record<string, unknown> = {}
      evaluate(code, {}, { globalThis: globals })
      return globals
    }
    expect(await read(paths.namespace)).toEqual({ value: 'namespace' })
    expect(await read(paths.alias)).toEqual({ value: 'alias', helperLoads: 1 })
    if (mode === 'development') {
      await fs.writeFile(
        path.join(root, 'value.ts'),
        `export const value = 'updated'`,
      )
      await until(
        async () => (await read(paths.alias)).value === 'updated',
        'preload callback dependency rebuilds',
      )
      await fs.writeFile(
        path.join(root, 'alias.ts'),
        `import * as api from 'electron-trio'; import { value } from './value'; import './effects'; const define = api.createPreload; export default define(() => { globalThis.value = value + ':local' })`,
      )
      await until(
        async () => (await read(paths.alias)).value === 'updated:local',
        'preload local factory alias rebuilds',
      )
    }
  },
)

test('a failed preload build releases its watcher and can be retried after repair', async (t) => {
  const root = await fixture(t, {
    'main.ts': `export { default } from './preload'`,
    'preload.ts': `import { createPreload } from 'electron-trio'; import { value } from './value'; export default createPreload(() => { globalThis.value = value })`,
    'value.ts': `export const value = @invalid`,
    'vite.config.ts': `${configImports}
      export default {
        logLevel: 'silent',
        plugins: [electronPlugin(${JSON.stringify(options)}), preloadPlugin(), {
          name: 'test:closed-preload',
          closeWatcher() { if (this.environment.name === 'electron_preload') fs.appendFileSync(new URL('./closed', import.meta.url), 'x') },
        }],
        environments: { electron_preload: { build: { watch: ${JSON.stringify(fixtureWatch)} } } },
      }`,
  })
  const closed = () => fs.readFile(path.join(root, 'closed'), 'utf8')
  const server = await createServer({ root })
  t.onTestFinished(() => server.close())
  const environment = server.environments.electron_main
  const runner = fetchRunner(t, environment)
  await expect(runner.import(path.join(root, 'main.ts'))).rejects.toThrow()
  expect(await closed()).toBe('x')
  await fs.writeFile(path.join(root, 'value.ts'), 'export const value = 42')
  environment.moduleGraph.invalidateAll()
  runner.clearCache()
  const { default: output } = await runner.import<{ default: string }>(
    path.join(root, 'main.ts'),
  )
  const globals = {}
  evaluate(await fs.readFile(output, 'utf8'), {}, { globalThis: globals })
  expect(globals).toEqual({ value: 42 })
  await server.close()
  expect(await closed()).toBe('xx')
})

test('different preload entries cannot overwrite the same configured output', async (t) => {
  const root = await fixture(t, {
    'index.html': '',
    'main.ts': `export { default as first } from './first'; export { default as second } from './second'`,
    'first.ts': `import { createPreload } from 'electron-trio'; export default createPreload(() => {})`,
    'second.ts': `import { createPreload } from 'electron-trio'; export default createPreload(() => {})`,
  })
  const builder = await createBuilder({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [electronPlugin(options), preloadPlugin()],
    environments: {
      electron_preload: {
        build: {
          rolldownOptions: { output: { entryFileNames: 'preload.cjs' } },
        },
      },
    },
  })
  await expect(builder.buildApp()).rejects.toThrow('Preload output collision')
})

test.for(['development', 'production'] as const)(
  'preload discovery and compilation use preceding transforms in %s',
  async (mode, t) => {
    const generated = `import { createPreload } from 'electron-trio'; import { value } from './value'; export default createPreload(() => { globalThis.value = value })`
    const root = await fixture(t, {
      'index.html': '',
      'main.ts': `export { default as preload } from './preload'`,
      'preload.ts': `export default 'GENERATE_PRELOAD'`,
      'value.ts': `export const value = 'transformed'`,
      'vite.config.ts': `${configImports}
        export default {
          logLevel: 'silent',
          plugins: [{
            name: 'test:generate-preload',
            enforce: 'pre',
            transform(code, id) {
              if (id.endsWith('/preload.ts') && code.includes('GENERATE_PRELOAD')) return ${JSON.stringify(generated)}
            },
          }, electronPlugin(${JSON.stringify(options)}), preloadPlugin()],
          environments: {
            electron_main: { build: { rolldownOptions: { output: { format: 'cjs', entryFileNames: 'main.cjs' } } } },
            electron_preload: { build: { watch: ${JSON.stringify(fixtureWatch)} } },
          },
        }`,
    })
    let preload: string
    if (mode === 'development') {
      const server = await createServer({ root })
      t.onTestFinished(() => server.close())
      const main = server.environments.electron_main
      const result = await fetchRunner(t, main).import<{ preload: string }>(
        path.join(root, 'main.ts'),
      )
      preload = result.preload
      expect(
        main.moduleGraph.getModuleById(path.join(root, 'preload.ts')),
      ).toBeDefined()
      expect(
        main.moduleGraph.getModuleById(path.join(root, 'value.ts')),
      ).toBeUndefined()
    } else {
      const builder = await createBuilder({ root })
      await builder.buildApp()
      preload = createRequire(import.meta.url)(
        path.join(root, 'dist/main/main.cjs'),
      ).preload
    }
    expect(path.isAbsolute(preload)).toBe(true)
    const globals: Record<string, unknown> = {}
    evaluate(await fs.readFile(preload, 'utf8'), {}, { globalThis: globals })
    expect(globals).toEqual({ value: 'transformed' })
  },
)

test.for(['development', 'production'] as const)(
  'a preload macro cannot replace the configured main entry in %s',
  async (mode, t) => {
    const root = await fixture(t, {
      'index.html': '',
      'main.ts': `import { createPreload } from 'electron-trio'; export default createPreload(() => {})`,
      'vite.config.ts': `${configImports}
        export default {
          logLevel: 'silent',
          plugins: [electronPlugin(${JSON.stringify(options)}), preloadPlugin()],
        }`,
    })
    if (mode === 'development') {
      const server = await createServer({ root })
      t.onTestFinished(() => server.close())
      const runner = fetchRunner(t, server.environments.electron_main)
      await expect(runner.import(path.join(root, 'main.ts'))).rejects.toThrow(
        'main entry',
      )
    } else {
      const builder = await createBuilder({ root })
      await expect(builder.buildApp()).rejects.toThrow('main entry')
    }
  },
)
