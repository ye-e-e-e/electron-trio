import { expect, test, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import type { HMRPayload } from 'vite'
import { ipcInvoke } from '#/vite'
import { until, sourceAliases } from './helpers'


test('Vite hotUpdate validates unimported definitions and refreshes cached proxies', { timeout: 30000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(path.resolve(import.meta.dirname, '..'), '.ipc-test-dev-'))
  const directory = path.join(root, 'src/ipc')
  await fs.mkdir(directory, { recursive: true })
  const definition = (channel: string) => `import { createIpcInvoke } from 'electron-ipc-invoke'; import { z } from 'zod'; export const run = createIpcInvoke('${channel}').inputValidator(z.void()).handler(() => 'MAIN_ONLY_SENTINEL')`
  const active = path.join(directory, 'active.ipc.ts')
  const hidden = path.join(directory, 'hidden.ipc.ts')
  await fs.writeFile(active, definition('active'))
  const server = await createServer({
    root, configFile: false, logLevel: 'silent', plugins: [ipcInvoke()[0]],
    resolve: { alias: sourceAliases },
    server: { middlewareMode: true, ws: false }, optimizeDeps: { noDiscovery: true, include: [] },
  })
  t.onTestFinished(async () => { await server.close(); await fs.rm(root, { recursive: true, force: true }) })
  const messages: HMRPayload[] = []
  vi.spyOn(server.environments.client.hot, 'send').mockImplementation((message) => {
    if (typeof message !== 'string') messages.push(message)
  })
  await until(() => Object.hasOwn(server.watcher.getWatched(), directory), 'definition watcher')
  const initial = await server.transformRequest('/src/ipc/active.ipc.ts')
  expect(initial!.code).not.toMatch(/MAIN_ONLY_SENTINEL|zod/)

  await fs.writeFile(hidden, definition('active'))
  await until(() => messages.some((message) => message.type === 'error' && /Duplicate IPC channel/.test(message.err.message)), 'unimported duplicate error')

  messages.length = 0
  await fs.unlink(hidden)
  await until(() => messages.some((message) => message.type === 'full-reload'), 'duplicate removal recovery')

  messages.length = 0
  await fs.writeFile(active, definition('renamed'))
  await until(() => messages.some((message) => message.type === 'full-reload'), 'channel update')
  const updated = await server.transformRequest('/src/ipc/active.ipc.ts')
  expect(updated!.code).not.toBe(initial!.code)
  expect(updated!.code).toMatch(new RegExp(Buffer.from('renamed', 'utf16le').toString('hex')))
  expect(updated!.code).not.toMatch(/MAIN_ONLY_SENTINEL|zod/)
})
