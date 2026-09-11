import { expect, test } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { build, createServer } from 'vite'
import type { Rolldown } from 'vite'

import { ipcInvoke } from '#/vite'
import { until, definition, sourceAliases } from './helpers'


test('target plugins regenerate watched outputs for additions, renames, deletions and error recovery', { timeout: 45000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(path.resolve(import.meta.dirname, '..'), '.ipc-test-watch-'))
  const watchers: Rolldown.RolldownWatcher[] = []
  t.onTestFinished(async () => {
    for (const watcher of watchers) await watcher.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  const directory = path.join(root, 'electron')
  await fs.mkdir(directory, { recursive: true })
  const first = path.join(directory, 'first.ipc.ts')
  await fs.writeFile(first, definition('first'))
  await fs.writeFile(path.join(root, 'main.ts'), `export const started = true`)
  await fs.writeFile(path.join(root, 'preload.ts'), ``)

  const ipc = ipcInvoke()
  const server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [ipc.renderer()], resolve: { alias: sourceAliases }, server: { middlewareMode: true, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } })
  t.onTestFinished(() => server.close())
  const outputs = { main: '', preload: '' }
  const errors: Error[] = []
  const building = new Set()
  const waitFor = (predicate: () => unknown, label: string) => until(() => building.size === 0 && predicate(), label)
  for (const target of ['main', 'preload'] as const) {
    let pendingOutput: string | undefined
    const watcher = await build({
      root, configFile: false, logLevel: 'silent',
      resolve: { alias: sourceAliases },
      plugins: [
        ipc[target](),
        {
          name: 'test-capture-output',
          async writeBundle() {
            pendingOutput = await fs.readFile(path.join(root, `out-${target}/${target}.mjs`), 'utf8')
          },
        },
      ],
      build: {
        watch: {}, minify: false, outDir: `out-${target}`,
        lib: { entry: path.join(root, `${target}.ts`), formats: ['es'], fileName: () => `${target}.mjs` },
        rolldownOptions: { external: ['electron'] },
      },
    })
    if (Array.isArray(watcher) || !('on' in watcher)) throw new Error('Expected a build watcher')
    watcher.on('event', (event) => {
      if (event.code === 'START') building.add(target)
      if (event.code === 'END') building.delete(target)
      if (event.code === 'ERROR') errors.push(event.error)
      // A native file event and an IPC signal may start separate builds for one edit.
      if (event.code === 'END' && pendingOutput !== undefined) {
        outputs[target] = pendingOutput
        pendingOutput = undefined
      }
    })
    watchers.push(watcher)
  }
  await waitFor(() => outputs.main && outputs.preload, 'initial builds')
  expect(outputs.main).toMatch(/first/)
  expect(outputs.preload).toMatch(/first/)

  await fs.mkdir(path.join(directory, 'nested'))
  const second = path.join(directory, 'nested/second.ipc.ts')
  await fs.writeFile(second, definition('second'))
  await waitFor(() => outputs.preload.includes('second') && outputs.main.includes('second'), 'added channel')

  await fs.writeFile(first, definition('renamed'))
  await waitFor(() => outputs.preload.includes('renamed') && outputs.main.includes('renamed'), 'renamed channel')
  expect(outputs.preload).not.toMatch(/"first"/)

  await fs.unlink(second)
  await waitFor(() => !outputs.preload.includes('second') && !outputs.main.includes('\"second\"'), 'deleted channel')

  const beforeError = { ...outputs }
  await fs.writeFile(first, `export const broken =`)
  await waitFor(() => errors.length > 0, 'compile error')
  await delay(200)
  expect(outputs).toStrictEqual(beforeError)
  await fs.writeFile(first, definition('recovered'))
  await waitFor(() => outputs.preload.includes('recovered') && outputs.main.includes('recovered'), 'recovery')

  const bridgeBeforeBodyChange = outputs.preload
  await fs.writeFile(first, definition('recovered').replace('() => 1', '() => "BODY_UPDATED"'))
  await waitFor(() => outputs.main.includes('BODY_UPDATED'), 'handler implementation update')
  expect(outputs.preload).toBe(bridgeBeforeBodyChange)

  // Helpers outside the definition glob are tracked by the main build graph.
  const helper = path.join(directory, 'helper.ts')
  await fs.writeFile(helper, `export const value = 'HELPER_BEFORE'`)
  await fs.writeFile(first, `import { value } from './helper'; import { z } from 'zod'; import { createIpcInvoke } from 'electron-ipc-invoke'; export const run = createIpcInvoke('recovered').inputValidator(z.unknown()).handler(() => value)`)
  await waitFor(() => outputs.main.includes('HELPER_BEFORE'), 'helper import')
  await fs.writeFile(helper, `export const value = 'HELPER_AFTER'`)
  await waitFor(() => outputs.main.includes('HELPER_AFTER'), 'main-only dependency update')
  expect(outputs.preload).toMatch(/recovered/)

  await fs.unlink(first)
  await waitFor(() => !outputs.preload.includes('recovered'), 'empty registry')
  await fs.writeFile(first, definition('first-again'))
  await waitFor(() => outputs.preload.includes('first-again'), 'adding to an empty registry')
})
