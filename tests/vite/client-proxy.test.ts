import { expect, test, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'vite'
import type { HotPayload } from 'vite'
import { ipcInvoke } from '#/vite'
import { bundle, cjs, entryCode, evaluate, fixture, sourceAliases } from '../helpers'

test.for([undefined, '__custom"\\bridge'])('virtual renderer helpers use the configured bridge and reject invalid configuration: %s', async (bridgeName, t) => {
  const root = await fixture(t, {
    'helpers.ts': "export { createRendererInvoker, createDevRendererInvoker } from 'virtual:electron-ipc-invoke:renderer'",
  })
  const output = await bundle(root, ipcInvoke({ bridgeName })[0], 'helpers.ts', cjs(root, 'helpers.ts'))
  type InvokerFactory = (channel: string) => (input: unknown) => Promise<unknown>
  type Invokers = {
    createRendererInvoker: InvokerFactory
    createDevRendererInvoker: (moduleKey: string, exportName: string) => (input: unknown) => Promise<unknown>
  }
  const bridge: Record<string, unknown> = {
    ['__proto__']: async (input: unknown) => input,
    invalid: 1,
    invoke: (moduleKey: string, exportName: string, input: unknown) => [moduleKey, exportName, input],
  }
  const code = entryCode(output)
  const { createRendererInvoker, createDevRendererInvoker } = evaluate<Invokers>(code, {}, {
    [bridgeName ?? '__ipc']: bridge,
  })
  const input = [1, 'x']
  expect(await createRendererInvoker('__proto__')(input)).toBe(input)
  await expect(createRendererInvoker('toString')(undefined)).rejects.toThrow(/missing channel/)
  await expect(createRendererInvoker('invalid')(undefined)).rejects.toThrow(/Invalid IPC bridge method/)
  expect(await createDevRendererInvoker('/functions.ts', '__proto__')(input)).toStrictEqual(['/functions.ts', '__proto__', input])
  bridge.invoke = 1
  await expect(createDevRendererInvoker('/functions.ts', 'run')(undefined)).rejects.toThrow(/preload configuration/)
  const missing = evaluate<Invokers>(code)
  await expect(missing.createRendererInvoker('run')(undefined)).rejects.toThrow(/preload configuration/)
  await expect(missing.createDevRendererInvoker('/functions.ts', 'run')(undefined)).rejects.toThrow(/preload configuration/)
})

test.for(['raw', 'url'])('development resource imports with ?%s bypass definition conversion', async (query, t) => {
  const root = await fixture(t, {
    'definition.ts': "import { createIpcInvoke } from 'electron-ipc-invoke'; export const run = createIpcInvoke('run').handler(() => 1)",
  })
  const server = await createServer({
    root, configFile: false, logLevel: 'silent', plugins: [ipcInvoke()[0]],
    resolve: { alias: sourceAliases }, server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true },
  })
  t.onTestFinished(() => server.close())
  const resource = await server.transformRequest(`/definition.ts?${query}`)
  expect(resource?.code).toContain('export default')
  expect(resource?.code).not.toContain('createDevRendererInvoker')
  expect((await server.transformRequest('/definition.ts'))?.code).toContain('createDevRendererInvoker')
})

test('renderer discovers imported definitions and refreshes only changed contracts', { timeout: 30000 }, async t => {
  const definition = (channel: string, body = 'MAIN_ONLY_SENTINEL') => `import { createIpcInvoke } from 'electron-ipc-invoke'; import { z } from 'zod'; export const run = createIpcInvoke('${channel}').inputValidator(z.void()).handler(() => '${body}')`
  const root = await fixture(t, { 'active.ts': definition('active'), 'hidden.ts': 'invalid @@@' })
  const active = path.join(root, 'active.ts')
  const server = await createServer({
    root, configFile: false, logLevel: 'silent', plugins: [ipcInvoke()[0]],
    resolve: { alias: sourceAliases }, server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  t.onTestFinished(() => server.close())
  expect(server.environments).toHaveProperty('ipc_invoke')
  const messages: HotPayload[] = []
  vi.spyOn(server.environments.client.hot, 'send').mockImplementation(message => {
    if (typeof message !== 'string') messages.push(message)
  })
  const initial = await server.transformRequest('/active.ts')
  expect(initial!.code).not.toMatch(/MAIN_ONLY_SENTINEL|zod/)
  expect(JSON.stringify(initial!.map)).not.toMatch(/MAIN_ONLY_SENTINEL|inputValidator|zod/)
  await fs.writeFile(path.join(root, 'hidden.ts'), definition('active'))
  await delay(200)
  expect(messages).toEqual([])
  await fs.writeFile(active, definition('active', 'UPDATED_BODY'))
  await delay(250)
  expect(messages).toEqual([])
  expect((await server.transformRequest('/active.ts'))!.code).toBe(initial!.code)
  await fs.writeFile(active, definition('renamed'))
  await delay(250)
  expect(messages).toEqual([])
  const updated = await server.transformRequest('/active.ts')
  expect(updated!.code).toBe(initial!.code)
  expect(updated!.code).toContain(JSON.stringify(active))
  expect(updated!.code).not.toMatch(/MAIN_ONLY_SENTINEL|zod/)
  expect(JSON.stringify(updated!.map)).not.toMatch(/MAIN_ONLY_SENTINEL|inputValidator|zod/)
})

test('the IPC environment merges application options during configuration', async t => {
  const root = await fixture(t, {})
  const server = await createServer({
    root, configFile: false, logLevel: 'silent', plugins: [ipcInvoke()[0]],
    server: { middlewareMode: true, ws: false },
    environments: { ipc_invoke: { define: { __IPC_VALUE__: '42' } } },
  })
  t.onTestFinished(() => server.close())
  expect(server.environments.ipc_invoke.config.consumer).toBe('server')
  expect(server.environments.ipc_invoke.config.define?.__IPC_VALUE__).toBe('42')
})
