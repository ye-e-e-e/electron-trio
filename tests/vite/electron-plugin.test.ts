import fs from 'node:fs/promises'
import path from 'node:path'
import { createBuilder, createServer, resolveConfig } from 'vite'
import { expect, test, vi } from 'vitest'
import { electronTrio } from '#/vite'
import { DEV_CHANNEL } from '#/vite/ipc-entry-plugin/constants'
import {
  evaluate,
  fetchRunner,
  fixture,
  sourceAliases,
  until,
  fixtureWatch,
} from '../helpers'

const options = { entry: 'main.ts' }

test('one plugin configures Electron environments and preserves environment overrides', async (t) => {
  const root = await fixture(t)
  const config = await resolveConfig(
    {
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [electronTrio(options)],
      environments: {
        electron_main: { define: { __MAIN__: '42' } },
        electron_preload: {
          define: { __PRELOAD__: '42' },
          resolve: { external: ['custom-native'] },
          build: { outDir: 'custom', target: 'node24' },
        },
      },
    },
    'serve',
  )
  expect(config.build.outDir).toBe('dist')
  expect(config.environments.client.build.outDir).toBe(
    path.join('dist', 'client'),
  )
  expect(config.environments.electron_main.consumer).toBe('server')
  expect(config.environments.electron_main.build.outDir).toBe(
    path.join('dist', 'main'),
  )
  expect(config.environments.electron_main.define?.__MAIN__).toBe('42')
  expect(config.environments.electron_main.build.rolldownOptions.input).toBe(
    path.join(root, 'main.ts'),
  )
  expect(config.environments.electron_preload.build.outDir).toBe('custom')
  expect(config.environments.electron_preload.build.target).toBe('node24')
  expect(config.environments.electron_preload.define?.__PRELOAD__).toBe('42')
  expect(config.environments.electron_preload.resolve.external).toEqual([
    'electron',
    'custom-native',
  ])
  expect(
    config.environments.electron_preload.build.rolldownOptions.output,
  ).toMatchObject({ format: 'cjs', entryFileNames: '[name].cjs' })
})

test('server setup creates a preload builder from local config with development mode and fresh plugins', async (t) => {
  const root = await fixture(t, {
    'main.ts': '',
    'paths.ts': `export { default } from './preload'`,
    'preload.ts': `import { createPreload } from 'electron-trio'; import { contextBridge } from 'electron'; import { value } from '@value'; import { prefix } from 'virtual:test-file-preload'; export default createPreload(() => contextBridge.exposeInMainWorld('value', prefix + value + __SUFFIX__))`,
    'value.ts': `export const value: string = 'first'`,
    'vite.config.ts': `throw new Error('The selected config file must be used')`,
    'electron.config.ts': `
      import fs from 'node:fs'
      import { randomUUID } from 'node:crypto'
      import { fileURLToPath } from 'node:url'
      import { electronTrio } from ${JSON.stringify(path.resolve(import.meta.dirname, '../../src/vite.ts'))}
      export default ({ command, mode }) => {
        const instance = randomUUID()
        fs.appendFileSync(new URL('./configs.jsonl', import.meta.url), JSON.stringify({ command, mode, instance }) + '\\n')
        return {
          logLevel: 'silent',
          plugins: [electronTrio({ entry: 'main.ts', bridgeName: 'desktop' }), {
            name: 'test:file-preload-build', apply: 'build',
            applyToEnvironment: environment => environment.name === 'electron_preload',
            resolveId(id) { if (id === 'virtual:test-file-preload') return '\\0test-file-preload' },
            load(id) { if (id === '\\0test-file-preload') return 'export const prefix = ' + JSON.stringify('file:' + mode + ':') },
          }],
          resolve: { alias: { '@value': fileURLToPath(new URL('./value.ts', import.meta.url)) } },
          environments: { electron_preload: {
            define: { __SUFFIX__: JSON.stringify(':built') },
            build: { outDir: 'custom-preload', sourcemap: true, watch: ${JSON.stringify(fixtureWatch)} },
          } },
        }
      }`,
  })
  const commands: string[] = []
  const server = await createServer({
    root,
    configFile: path.join(root, 'electron.config.ts'),
    mode: 'staging',
    plugins: [
      {
        name: 'test:session-only',
        config(_config, { command }) {
          commands.push(command)
        },
      },
    ],
    server: { host: '127.0.0.1', port: 0 },
  })
  t.onTestFinished(() => server.close())
  const configs = (await fs.readFile(path.join(root, 'configs.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(configs).toEqual([
    { command: 'serve', mode: 'staging', instance: expect.any(String) },
    { command: 'build', mode: 'development', instance: expect.any(String) },
  ])
  expect(configs[0].instance).not.toBe(configs[1].instance)
  expect(commands).toEqual(['serve'])
  await expect(fs.access(path.join(root, 'custom-preload'))).rejects.toThrow()
  const runner = fetchRunner(t, server.environments.electron_main)
  const { default: output } = await runner.import<{ default: string }>(
    path.join(root, 'paths.ts'),
  )
  const invoke = vi.fn().mockResolvedValue(42)
  const exposeInMainWorld = vi.fn()
  evaluate(await fs.readFile(output, 'utf8'), {
    contextBridge: { exposeInMainWorld },
    ipcRenderer: { invoke },
  })
  expect(
    (await fs.readFile(path.join(root, 'configs.jsonl'), 'utf8'))
      .trim()
      .split('\n'),
  ).toHaveLength(2)
  expect(path.dirname(output)).toBe(path.join(root, 'custom-preload'))
  await fs.access(output + '.map')
  expect(exposeInMainWorld).toHaveBeenCalledWith(
    'value',
    'file:development:first:built',
  )
  const bridge = exposeInMainWorld.mock.calls.find(
    ([name]) => name === 'desktop',
  )?.[1]
  await expect(bridge.invoke('/functions.ts', 'run', 1)).resolves.toBe(42)
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    DEV_CHANNEL,
    '/functions.ts',
    'run',
    1,
  )
  await fs.writeFile(
    path.join(root, 'value.ts'),
    `export const value: string = 'updated'`,
  )
  await until(
    async () => (await fs.readFile(output, 'utf8')).includes('updated'),
    'preload dependency rebuild',
  )
  exposeInMainWorld.mockClear()
  evaluate(await fs.readFile(output, 'utf8'), {
    contextBridge: { exposeInMainWorld },
    ipcRenderer: { invoke },
  })
  expect(exposeInMainWorld).toHaveBeenCalledWith(
    'value',
    'file:development:updated:built',
  )
  expect(
    exposeInMainWorld.mock.calls.find(([name]) => name === 'desktop')?.[1],
  ).toHaveProperty('invoke')
})

test('production reuses the application builder and manifest across separate preload environments', async (t) => {
  const root = await fixture(t, {
    'index.html': '<script type="module" src="/renderer.ts"></script>',
    'renderer.ts': `import { run } from './functions'; console.log(run())`,
    'functions.ts': `import { createIpcInvoke } from 'electron-trio'; export const run = createIpcInvoke('first').handler(() => 42)`,
    'main.ts': `export { default as first } from './first'; export { default as second } from './second'`,
    'first.ts': `import { createPreload } from 'electron-trio'; export default createPreload(() => { globalThis.entry = 'first' })`,
    'second.ts': `import { createPreload } from 'electron-trio'; export default createPreload(() => { globalThis.entry = 'second' })`,
  })
  const modes = new Map<string, string>()
  const buildOrder: string[] = []
  const configResolved = vi.fn()
  const builder = await createBuilder({
    root,
    configFile: false,
    logLevel: 'silent',
    mode: 'staging',
    resolve: { alias: sourceAliases },
    build: { outDir: 'output' },
    environments: {
      electron_preload: {
        build: {
          // Per-entry builds replace input and disable watch without changing this template.
          watch: fixtureWatch,
          rolldownOptions: { input: { unused: 'missing.ts' } },
        },
      },
    },
    builder: {
      async buildApp() {
        buildOrder.push('application')
      },
    },
    plugins: [
      electronTrio(options),
      {
        name: 'test:outputs',
        configResolved,
        writeBundle() {
          buildOrder.push(this.environment.name)
          modes.set(this.environment.name, this.environment.config.mode)
        },
      },
    ],
  })
  const build = vi.spyOn(builder, 'build')
  await builder.buildApp()
  expect(configResolved).toHaveBeenCalledExactlyOnceWith(builder.config)
  const preloads = build.mock.calls
    .map(([environment]) => environment)
    .filter((environment) => environment.name === 'electron_preload')
  expect(preloads).toHaveLength(2)
  expect(preloads[0]).not.toBe(preloads[1])
  const template = builder.environments.electron_preload
  expect(template.config.build.rolldownOptions.input).toEqual({
    unused: 'missing.ts',
  })
  expect(template.config.build.watch).toEqual(fixtureWatch)
  expect((await fs.readdir(path.join(root, 'output'))).sort()).toEqual([
    'client',
    'main',
    'preload',
  ])
  expect(buildOrder).toEqual([
    'client',
    'electron_preload',
    'electron_preload',
    'electron_main',
    'application',
  ])
  expect([...modes.values()]).toEqual(['staging', 'staging', 'staging'])
  const entries = new Set<string>()
  for (const file of await fs.readdir(path.join(root, 'output/preload'))) {
    const globals: Record<string, string> = {}
    const exposeInMainWorld = vi.fn()
    const invoke = vi.fn().mockResolvedValue(42)
    evaluate(
      await fs.readFile(path.join(root, 'output/preload', file), 'utf8'),
      {
        contextBridge: { exposeInMainWorld },
        ipcRenderer: { invoke },
      },
      { globalThis: globals },
    )
    entries.add(globals.entry)
    expect(exposeInMainWorld).toHaveBeenCalledTimes(1)
    const bridge = exposeInMainWorld.mock.calls[0][1]
    await expect(bridge.first(1)).resolves.toBe(42)
    expect(invoke).toHaveBeenCalledExactlyOnceWith('first', 1)
  }
  expect(entries).toEqual(new Set(['first', 'second']))
})

test('an invalid discovered preload rejects its main import', async (t) => {
  const root = await fixture(t, {
    'main.ts': '',
    'paths.ts': `export { default } from './preload'`,
    'preload.ts': `import { createPreload } from 'electron-trio'; export default createPreload(() => { invalid syntax @@@ })`,
    'vite.config.ts': `import { electronTrio } from ${JSON.stringify(path.resolve(import.meta.dirname, '../../src/vite.ts'))};
      export default { logLevel: 'silent', plugins: [electronTrio(${JSON.stringify(options)})] }`,
  })
  const server = await createServer({
    root,
    server: { host: '127.0.0.1', port: 0 },
  })
  t.onTestFinished(() => server.close())
  const runner = fetchRunner(t, server.environments.electron_main)
  await expect(runner.import(path.join(root, 'paths.ts'))).rejects.toThrow()
})
