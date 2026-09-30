import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { expect, test, vi } from 'vitest'
import { ipcMainPlugin } from '#/vite/ipc-main-plugin/plugin'
import { IpcContext } from '#/vite/ipc-plugin/context'
import { IpcRegistry } from '#/vite/ipc-plugin/ipc-registry'
import { IpcProvider } from '#/vite/ipc-provider-plugin/provider'
import {
  definition,
  fixture,
  providerTestPlugins,
  sourceAliases,
} from '../helpers'

test('provider invalidates only the implementation when a handler changes', async (t) => {
  const root = await fixture(t, { 'functions.ts': definition('run') })
  const context = new IpcContext({})
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    cacheDir: path.join(root, '.vite'),
    resolve: { alias: sourceAliases },
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, ws: false, watch: null },
    plugins: [ipcMainPlugin(context), providerTestPlugins(context)],
  })
  t.onTestFinished(() => server.close())
  const environment = server.environments.electron_main
  const key = path.join(root, 'functions.ts')
  await environment.transformRequest(key)
  await environment.transformRequest(key + '?variant=desktop')
  await environment.transformRequest(key + '?raw')
  await environment.transformRequest(`${key}?ipc-implementation`)
  const proxy = environment.moduleGraph.getModuleById(key)!
  const variant = environment.moduleGraph.getModuleById(
    key + '?variant=desktop',
  )!
  const resource = environment.moduleGraph.getModuleById(key + '?raw')!
  const implementation = environment.moduleGraph.getModuleById(
    `${key}?ipc-implementation`,
  )!
  const previous = proxy.transformResult
  const previousVariant = variant.transformResult
  const invalidate = vi.spyOn(environment.moduleGraph, 'invalidateModule')
  const provider = new IpcProvider(environment, context.registry)
  t.onTestFinished(() => provider.close())

  const code = definition('run').replace('() => 1', '() => 2')
  await fs.writeFile(key, code)
  const updates = await provider.hotUpdate({
    type: 'update',
    file: key,
    timestamp: Date.now(),
    server,
    modules: [proxy, variant, resource, implementation],
    read: () => code,
  })
  expect(updates).toEqual([resource, implementation])
  expect(invalidate.mock.calls.map(([node]) => node)).toEqual([
    resource,
    implementation,
  ])
  expect(proxy.transformResult).toBe(previous)
  expect(variant.transformResult).toBe(previousVariant)
  expect(implementation.transformResult?.code).toContain('() => 2')
})

test('invocation validation waits for missing dependency recovery to finish', async (t) => {
  const root = await fixture(t, { 'definition.ts': definition('run') })
  const key = path.join(root, 'definition.ts')
  const registry = new IpcRegistry()
  await registry.register(definition('run'), key, 'main')
  let start!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    start = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const server = await createServer({
    configFile: false,
    root,
    publicDir: false,
    logLevel: 'silent',
    resolve: { alias: sourceAliases },
    server: { middlewareMode: true, ws: false, watch: null },
    environments: { electron_main: { consumer: 'server' } },
    plugins: [
      {
        name: 'test:hold-dependency-recovery',
        async resolveId(source) {
          if (source !== './missing') return
          start()
          await blocked
          return '\0recovered'
        },
      },
    ],
  })
  const provider = new IpcProvider(server.environments.electron_main, registry)
  t.onTestFinished(async () => {
    release()
    await provider.close()
    await server.close()
  })
  await provider.resolveImport('./missing', key, async () => null)
  const update = provider.hotUpdate({
    type: 'create',
    file: path.join(root, 'missing.ts'),
    timestamp: Date.now(),
    server,
    modules: [],
    read: () => '',
  })
  await started
  const lookup = vi.spyOn(registry, 'lookup')
  const result = provider.validate({
    caller: 'main',
    moduleKey: key,
    exportName: 'run',
  })
  await Promise.resolve()
  expect(lookup).not.toHaveBeenCalled()
  release()
  await update
  await result
  expect(lookup).toHaveBeenCalledTimes(1)
})

test('source edits discard missing imports from every query variant while retaining unrelated recovery', async (t) => {
  const root = await fixture(t)
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    server: { middlewareMode: true, ws: false, watch: null },
  })
  t.onTestFinished(() => server.close())
  const environment = server.environments.ssr
  const provider = new IpcProvider(environment, new IpcRegistry())
  t.onTestFinished(() => provider.close())
  const key = path.join(root, 'definition.ts')
  const unrelated = path.join(root, 'other.ts')
  for (const importer of [
    key,
    `${key}?ipc-implementation`,
    key + '?variant=desktop',
    unrelated,
  ]) {
    await provider.resolveImport('./missing', importer, async () => null)
  }

  provider.clearUnresolvedImports(key)
  const resolve = vi
    .spyOn(environment.pluginContainer, 'resolveId')
    .mockResolvedValue(null)
  await provider.hotUpdate({
    type: 'create',
    file: path.join(root, 'missing.ts'),
    timestamp: Date.now(),
    server,
    modules: [],
    read: () => '',
  })
  expect(resolve.mock.calls.map(([, importer]) => importer)).toEqual([
    unrelated,
  ])
})
