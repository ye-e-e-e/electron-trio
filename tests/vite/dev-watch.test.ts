import { expect, test } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { build, createServer } from 'vite'
import type { Rolldown } from 'vite'
import { ipcInvoke } from '#/vite'
import { RESOLVED_MAIN_CALLER_PREFIX } from '#/vite/main-proxy-plugin/constants'
import { fixture, until, sourceAliases } from '../helpers'

test('development main and preload watch only their fixed bootstrap graph', { timeout: 30000 }, async t => {
  const definition = (channel: string, body = 'IMPLEMENTATION_BODY') => `import { value } from './helper'; import { createIpcInvoke } from 'electron-ipc-invoke'; export const run = createIpcInvoke('${channel}').handler(() => '${body}' + value)`
  const root = await fixture(t, {
    'functions.ts': definition('first'), 'helper.ts': 'export const value = "before"',
    'barrel.ts': "export * from './functions'",
    'main.ts': "export * as api from './barrel'", 'preload.ts': '',
  })
  const [renderer, main, preload] = ipcInvoke()
  const server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [renderer], resolve: { alias: sourceAliases }, server: { middlewareMode: true, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } })
  const watchers: Rolldown.RolldownWatcher[] = []
  t.onTestFinished(async () => { await Promise.all(watchers.map(watcher => watcher.close())); await server.close() })
  const outputs = { main: '', preload: '' }
  const builds = { main: 0, preload: 0 }
  const dependencies = { main: [] as string[], preload: [] as string[] }
  let proxyExports: string[] = []
  const errors: unknown[] = []
  for (const target of ['main', 'preload'] as const) {
    const watcher = await build({
      root, configFile: false, logLevel: 'silent', resolve: { alias: sourceAliases },
      plugins: [target === 'main' ? main : preload, {
        name: 'test:watch-output',
        generateBundle() {
          dependencies[target] = [...this.getModuleIds()]
          if (target === 'main') proxyExports = dependencies.main
            .filter(id => id.startsWith(RESOLVED_MAIN_CALLER_PREFIX))
            .flatMap(id => this.getModuleInfo(id)?.exports ?? []).sort()
        },
        async writeBundle() { outputs[target] = await fs.readFile(path.join(root, `out-${target}/${target}.mjs`), 'utf8'); builds[target]++ },
      }],
      build: { watch: {}, minify: false, outDir: `out-${target}`, lib: { entry: path.join(root, `${target}.ts`), formats: ['es'], fileName: () => `${target}.mjs` }, rolldownOptions: { external: ['electron'] } },
    })
    if (Array.isArray(watcher) || !('on' in watcher)) throw new Error('Expected build watcher')
    watcher.on('event', event => { if (event.code === 'ERROR') errors.push(event.error) })
    watchers.push(watcher)
  }
  await until(() => { if (errors.length) throw errors[0]; return outputs.main && outputs.preload }, 'initial builds')
  await server.transformRequest('/functions.ts')
  const initial = { ...outputs }
  const counts = { ...builds }
  expect(outputs.main).not.toContain('IMPLEMENTATION_BODY')
  for (const target of ['main', 'preload'] as const) {
    expect(dependencies[target]).not.toContain(path.join(root, 'functions.ts'))
    expect(dependencies[target]).not.toContain(path.join(root, 'helper.ts'))
  }
  await fs.writeFile(path.join(root, 'functions.ts'), definition('renamed', 'UPDATED_BODY'))
  await fs.writeFile(path.join(root, 'helper.ts'), 'export const value = "after"')
  await delay(350)
  await fs.writeFile(path.join(root, 'functions.ts'), 'invalid @@@')
  await delay(150)
  await fs.writeFile(path.join(root, 'functions.ts'), definition('repaired'))
  await delay(350)
  expect(outputs).toEqual(initial)
  expect(builds).toEqual(counts)
  expect(errors).toEqual([])

  await fs.writeFile(path.join(root, 'functions.ts'), definition('repaired') + '\nexport const added = createIpcInvoke("added").handler(() => 2)')
  await server.transformRequest('/functions.ts')
  await delay(200)
  expect(builds).toEqual(counts)
  expect(proxyExports).toEqual(['run'])
  await fs.writeFile(path.join(root, 'main.ts'), "export * as api from './barrel'; export { added } from './barrel'")
  await until(() => { if (errors.length) throw errors[0]; return builds.main > counts.main }, 'caller rebuild includes the added export')
  expect(proxyExports).toEqual(['added', 'run'])
  expect(builds.preload).toBe(counts.preload)

  const rebuilt = builds.main
  await fs.writeFile(path.join(root, 'functions.ts'), 'import { createIpcInvoke } from "electron-ipc-invoke"; export const added = createIpcInvoke("added").handler(() => 3)')
  await server.transformRequest('/functions.ts')
  await delay(200)
  expect(builds.main).toBe(rebuilt)
  await fs.writeFile(path.join(root, 'main.ts'), "export * as api from './barrel'; export const changed = true")
  await until(() => { if (errors.length) throw errors[0]; return builds.main > rebuilt }, 'caller rebuild removes the deleted export')
  expect(proxyExports).toEqual(['added'])
  expect(builds.preload).toBe(counts.preload)
})
