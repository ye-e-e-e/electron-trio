import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'vite'
import type { HotPayload } from 'vite'
import { expect, test, vi } from 'vitest'
import { IpcContext } from '#/vite/ipc-plugin/context'
import { ipcRendererPlugin } from '#/vite/ipc-renderer-plugin/plugin'
import { providerTestPlugins, testDispatcher } from '../helpers'
import { fixture, fixtureWatch, sourceAliases, until } from '../helpers'

test('ordinary renderer source updates preserve Vite HMR', async (t) => {
  const root = await fixture(t, {
    'ordinary.ts': 'export const value = 1; import.meta.hot.accept()',
  })
  let observed!: () => void
  const changed = new Promise<void>((resolve) => {
    observed = resolve
  })
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: sourceAliases },
    plugins: [
      ipcRendererPlugin(new IpcContext({})),
      {
        name: 'review:observe-hot-update',
        enforce: 'post',
        hotUpdate(context) {
          if (
            this.environment.name === 'client' &&
            context.file === path.join(root, 'ordinary.ts')
          )
            observed()
        },
      },
    ],
    server: { middlewareMode: true, ws: false, watch: fixtureWatch.chokidar },
    optimizeDeps: { noDiscovery: true },
  })
  t.onTestFinished(() => server.close())
  const messages: HotPayload[] = []
  vi.spyOn(server.environments.client.hot, 'send').mockImplementation(
    (payload) => {
      if (typeof payload !== 'string') messages.push(payload)
    },
  )
  await server.transformRequest('/ordinary.ts')
  await fs.writeFile(
    path.join(root, 'ordinary.ts'),
    'export const value = 2; import.meta.hot.accept()',
  )
  await changed
  await delay(50)
  expect(
    messages.some(
      (message) => message.type === 'update' || message.type === 'full-reload',
    ),
  ).toBe(true)
})

test('removing a renderer import retains encountered definitions for the development session', async (t) => {
  const definition =
    "import { createIpcInvoke } from 'electron-start'; export const run = createIpcInvoke('private').handler(() => 1)"
  const root = await fixture(t, {
    'definition.ts': definition,
    'entry.ts':
      'import { run } from "./definition"; export const call = () => run(); import.meta.hot.accept()',
  })
  const key = path.join(root, 'definition.ts')
  const context = new IpcContext({})
  await context.registry.register(definition, key, 'main')
  let observed!: () => void
  const changed = new Promise<void>((resolve) => {
    observed = resolve
  })
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: sourceAliases },
    plugins: [
      providerTestPlugins(context),
      {
        name: 'review:active-source',
        enforce: 'post',
        hotUpdate(context) {
          if (
            this.environment.name === 'client' &&
            context.file === path.join(root, 'entry.ts')
          )
            observed()
        },
      },
    ],
    server: { middlewareMode: true, ws: false, watch: fixtureWatch.chokidar },
    optimizeDeps: { noDiscovery: true },
  })
  t.onTestFinished(() => server.close())
  await server.transformRequest('/entry.ts')
  await server.transformRequest('/definition.ts')
  expect(
    context.registry.lookup({
      caller: 'renderer',
      moduleKey: key,
      exportName: 'run',
    }).moduleKey,
  ).toBe(key)
  await fs.writeFile(
    path.join(root, 'entry.ts'),
    'export const value = 1; import.meta.hot.accept()',
  )
  await changed
  await server.transformRequest('/entry.ts')
  const entry =
    await server.environments.client.moduleGraph.getModuleByUrl('/entry.ts')
  expect([...entry!.importedModules].some((module) => module.id === key)).toBe(
    false,
  )
  expect(
    context.registry.lookup({
      caller: 'main',
      moduleKey: key,
      exportName: 'run',
    }).channel,
  ).toBe('private')
  expect(
    context.registry.lookup({
      caller: 'renderer',
      moduleKey: key,
      exportName: 'run',
    }).moduleKey,
  ).toBe(key)
})

test('creating a previously missing implementation dependency recovers a failed definition', async (t) => {
  const definition = (helper: string) =>
    `import { value } from './${helper}'; import { createIpcInvoke } from 'electron-start'; export const run = createIpcInvoke('run').handler(() => value)`
  const root = await fixture(t, {
    'definition.ts': definition('helper'),
    'helper.ts': 'export const value = 1',
  })
  const key = path.join(root, 'definition.ts')
  const context = new IpcContext({})
  const registry = context.registry
  await registry.register(definition('helper'), key, 'main')
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: sourceAliases },
    server: { middlewareMode: true, ws: false, watch: fixtureWatch.chokidar },
    plugins: [providerTestPlugins(context)],
  })
  t.onTestFinished(() => server.close())
  const dispatcher = await testDispatcher(t, server)
  const call = () =>
    dispatcher.invoke(
      { caller: 'main', moduleKey: key, exportName: 'run' },
      undefined,
      undefined,
    )
  expect(await call()).toBe(1)
  await fs.writeFile(key, definition('new-helper'))
  await delay(250)
  await expect(call()).rejects.toThrow()
  await fs.writeFile(path.join(root, 'new-helper.ts'), 'export const value = 2')
  await until(async () => {
    try {
      return (await call()) === 2
    } catch {
      return false
    }
  }, 'missing dependency recovery')
  await fs.writeFile(
    path.join(root, 'new-helper.ts'),
    `import { result } from './late-child'; export const value = result`,
  )
  await until(async () => {
    try {
      await call()
      return false
    } catch {
      return true
    }
  }, 'missing transitive dependency')
  await fs.writeFile(
    path.join(root, 'late-child.ts'),
    'export const result = 3',
  )
  await until(async () => {
    try {
      return (await call()) === 3
    } catch {
      return false
    }
  }, 'transitive dependency recovery')
})

test.for(['', '?variant=desktop'])(
  'definition HMR skips implementation-only edits and propagates contract changes and repairs: %s',
  async (query, t) => {
    const source = (channel: string, value = 1, name = 'run') =>
      `import { createIpcInvoke } from 'electron-start'; export const ${name} = createIpcInvoke('${channel}').handler(() => ${value})`
    const root = await fixture(t, {
      'definition.ts': source('first'),
      'entry.ts': `import { run } from "./definition${query}"; globalThis.run = run; import.meta.hot.accept("./definition${query}", () => {})`,
    })
    const key = path.join(root, 'definition.ts')
    const requestId = '/definition.ts' + query
    const context = new IpcContext({})
    const updates: number[] = []
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      resolve: { alias: sourceAliases },
      plugins: [
        providerTestPlugins(context),
        {
          name: 'review:observe-definition-update',
          enforce: 'post',
          hotUpdate(context) {
            if (this.environment.name === 'client' && context.file === key)
              updates.push(context.modules.length)
          },
        },
      ],
      server: {
        middlewareMode: true,
        ws: false,
        // Keep successive fixture edits outside Chokidar's 50ms change throttle.
        watch: { ...fixtureWatch.chokidar, interval: 100 },
      },
      optimizeDeps: { noDiscovery: true },
    })
    t.onTestFinished(() => server.close())
    const messages: HotPayload[] = []
    vi.spyOn(server.environments.client.hot, 'send').mockImplementation(
      (payload) => {
        if (typeof payload !== 'string') messages.push(payload)
      },
    )
    await server.transformRequest('/entry.ts')
    await server.transformRequest(requestId)
    const lookup = (name = 'run') =>
      context.registry.lookup({
        caller: 'renderer',
        moduleKey: key,
        exportName: name,
      })
    await delay(150)
    messages.length = 0
    updates.length = 0

    await fs.writeFile(key, source('first', 2))
    await until(() => updates.length === 1, 'implementation-only update')
    expect(updates[0]).toBe(0)
    expect(messages).toEqual([])
    expect(lookup().exportName).toBe('run')

    // The implementation watcher can update the shared registry before renderer HMR.
    await context.registry.register(source('second', 2), key, 'renderer')
    await fs.writeFile(key, source('second', 2))
    await until(() => updates.length === 2, 'channel update')
    expect(updates[1]).toBe(0)
    expect(messages).toEqual([])
    expect(lookup().channel).toBe('second')
    expect((await server.transformRequest(requestId))?.code).toContain(
      'export const run',
    )

    messages.length = 0
    await fs.writeFile(key, source('second', 2) + '\ninvalid @@@')
    await until(
      () => messages.some((message) => message.type === 'error'),
      'definition failure',
    )
    expect(() => lookup()).toThrow()
    messages.length = 0
    await fs.writeFile(key, source('second', 3))
    await until(
      () => messages.some((message) => message.type === 'update'),
      'definition repair',
    )
    expect(lookup().exportName).toBe('run')
    await server.transformRequest(requestId)

    messages.length = 0
    await fs.writeFile(key, source('second', 3, 'renamed'))
    await until(
      () => messages.some((message) => message.type === 'update'),
      'export rename',
    )
    expect(lookup('renamed').exportName).toBe('renamed')
    expect((await server.transformRequest(requestId))?.code).toContain(
      'export const renamed',
    )

    await fs.unlink(key)
    await until(
      () => context.registry.read(key) === undefined,
      'definition deletion',
    )
    expect(() => lookup()).toThrow('Unknown IPC export')
    await fs.writeFile(key, source('restored'))
    await until(async () => {
      try {
        return (await server.transformRequest(requestId))?.code.includes(
          'export const run',
        )
      } catch {
        return false
      }
    }, 'definition restoration')
    expect(lookup().exportName).toBe('run')
  },
)
