import fs from 'node:fs/promises'
import path from 'node:path'
import { createBuilder, createServer } from 'vite'
import type { Plugin, ViteDevServer } from 'vite'
import { electronSimple } from 'vite-plugin-electron/multi-env'
import { expect, test } from 'vitest'
import { fixture } from '../helpers'

// Same target-plugin placement as the integration's independent development builder.
test('A0 multi-env captures main-only Rolldown aliases in buildStart and applies them to an isolated IPC environment', async t => {
  const root = await fixture(t, {
    'package.json': '{"type":"module"}',
    'index.html': '<script type="module" src="/renderer.ts"></script>',
    'renderer.ts': 'console.log("renderer")',
    'main.ts': 'import { value } from "@main-only"; console.log(value)',
    'helper.ts': 'export const value = "MAIN_TRANSFORM_TOKEN"',
  })
  let ipc: ViteDevServer | undefined
  t.onTestFinished(async () => { await ipc?.close() })
  const lifecycle: string[] = []
  let topHasAlias = false
  let resolvedAlias: unknown
  let transformed: string | undefined
  let intercepted = false
  let targetTransformRuns = 0
  // Explicit factory: fresh transform instances are intentionally installed in both contexts.
  // Arbitrary main plugin instances are never copied into the IPC server.
  const businessTransform = (): Plugin => ({
    name: 'a0:main-business-transform',
    transform(code, id) {
      if (id !== path.join(root, 'helper.ts')) return
      targetTransformRuns++
      return code.replace('MAIN_TRANSFORM_TOKEN', 'TRANSFORMED_IN_MAIN_AND_IPC')
    },
  })
  const target: Plugin = {
    name: 'a0:multi-env-target',
    configResolved() { lifecycle.push('configResolved') },
    async buildStart() {
      lifecycle.push(`buildStart:${this.environment.name}`)
      const environment = this.environment
      const top = environment.getTopLevelConfig()
      topHasAlias = top.resolve.alias.some(alias => alias.find === '@main-only')
      const options = environment.config.build.rolldownOptions
      if (Array.isArray(options)) throw new Error('Unexpected multiple input configurations')
      resolvedAlias = options.resolve?.alias
      const alias = Object.entries(options.resolve?.alias ?? {}).map(([find, value]) => {
        if (typeof value !== 'string') throw new Error('A0 migrates only one-to-one string aliases')
        return { find, replacement: value }
      })
      ipc = await createServer({
        root, configFile: false, logLevel: 'silent', publicDir: false,
        server: { middlewareMode: true, ws: false, watch: null },
        resolve: { alias },
        plugins: [businessTransform()],
        environments: { ipc_invoke: {
          consumer: 'server', keepProcessEnv: true,
          resolve: { conditions: environment.config.resolve.conditions, builtins: environment.config.resolve.builtins },
          dev: { moduleRunnerTransform: true },
        } },
      })
      const implementation = ipc.environments.ipc_invoke
      const resolved = await implementation.pluginContainer.resolveId('@main-only', path.join(root, 'main.ts'))
      expect(resolved?.id).toBe(path.join(root, 'helper.ts'))
      transformed = (await implementation.transformRequest(resolved!.id))?.code
    },
    resolveId: {
      order: 'pre',
      async handler(source, importer, options) {
        if (source !== '@main-only') return
        intercepted = true
        // The same normalization production interception needs before returning a virtual caller.
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
        expect(resolved?.id).toBe(path.join(root, 'helper.ts'))
        return resolved
      },
    },
  }
  const builder = await createBuilder({
    root, configFile: false, logLevel: 'silent',
    plugins: [electronSimple({ main: {
      input: path.join(root, 'main.ts'), plugins: [target, businessTransform()],
      options: { build: { outDir: 'electron-out', rolldownOptions: {
        resolve: { alias: { '@main-only': path.join(root, 'helper.ts') } },
        output: { entryFileNames: 'main.mjs' },
      } } },
    } })],
    build: { outDir: 'renderer-out' },
  })
  await builder.buildApp()
  expect(lifecycle).toEqual(['buildStart:electron_main'])
  expect(topHasAlias).toBe(false)
  expect(resolvedAlias).toEqual({ '@main-only': path.join(root, 'helper.ts') })
  expect(intercepted).toBe(true)
  expect(transformed).toContain('TRANSFORMED_IN_MAIN_AND_IPC')
  expect(targetTransformRuns).toBe(2)
  expect(await fs.readFile(path.join(root, 'electron-out/main.mjs'), 'utf8')).toContain('TRANSFORMED_IN_MAIN_AND_IPC')
})
