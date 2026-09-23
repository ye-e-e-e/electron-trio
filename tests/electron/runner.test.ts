import { expect, test } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { build, createServer, DevEnvironment } from 'vite'
import type { Plugin, ViteDevServer } from 'vite'
import electron from 'vite-plugin-electron/simple'
import { electronSimple } from 'vite-plugin-electron/multi-env'
import { createRpcServer } from '#/vite/ipc-provider-plugin/rpc-server'
import type { DevConnectionInfo } from '#/runtime/protocol'
import { fixture, sourceAliases, until, writeFiles } from '../helpers'

const binary = process.env.ELECTRON_BINARY
if (!binary) throw new Error('Set ELECTRON_BINARY to an installed Electron executable')

// A0 deliberately uses one explicitly known module and hand-written metadata.
// The production discovery/compiler is not involved in this feasibility gate.
for (const integration of ['simple', 'multi-env'] as const) {
  for (const format of ['es', 'cjs'] as const) {
    test(`A0 runner: ${integration}, ${format}`, { timeout: 60000 }, async (t) => {
      const root = await fixture(t, {
        'package.json': JSON.stringify({ type: 'module' }),
        'index.html': '<!doctype html><title>A0</title>',
        'helper.ts': 'export const value = "main-alias"',
        'barrel.ts': 'export { counter } from "./users"',
        'preload.ts': '',
      })
      const moduleKey = path.join(root, 'users.ts')
      const implementation = (version: number, invalid = false) => `
        import { createIpcInvoke } from 'electron-ipc-invoke'
        import { app } from 'electron'
        import { value } from '@main-only'
        let count = 0
        ${invalid ? 'this is invalid syntax @@@' : ''}
        export const counter = createIpcInvoke('counter').handler(({ event }) => ({
          count: ++count, version: ${version}, alias: value, electron: app.getName(),
          hasEvent: !!event?.sender, pid: process.pid, hasHot: import.meta.hot !== undefined,
        }))
        ${version >= 2 && version < 5 ? `export const added = createIpcInvoke('added').handler(() => ({ count: ++count, version: ${version}, pid: process.pid }))` : ''}
      `
      await fs.writeFile(moduleKey, implementation(1))
      const runtimeFile = path.join(root, 'runtime.mjs')
      await build({
        configFile: false, logLevel: 'silent',
        build: { minify: false, emptyOutDir: false, outDir: root,
          lib: { entry: path.resolve('src/dev.ts'), formats: ['es'], fileName: () => 'runtime.mjs' },
          rolldownOptions: { external: [/^vite\//, /^node:/, 'ws', 'electron'] },
        },
      })
      let connection: DevConnectionInfo
      let revision = 0
      let names = ['counter']
      let implementationServer: ViteDevServer | undefined
      const rpc = createRpcServer(async ({ payload, target }) => {
        if (payload.type !== 'custom') throw new Error('Invalid module request')
        if (payload.data.name === 'fetchModule' && !payload.data.data[1]) {
          if (!target || target.moduleKey !== moduleKey || !names.includes(target.exportName)) throw new Error('Unknown IPC definition')
        }
        return implementationServer!.environments.ipc_invoke.hot.handleInvoke(payload)
      })
      let rootServer: ViteDevServer | undefined
      let child: ChildProcess | undefined
      let stopped = false
      let log = ''
      const builds = { main: 0, preload: 0, starts: 0, configured: 0 }
      const watchers = new Set<{ close(): Promise<void> }>()
      t.onTestFinished(async () => {
        stopped = true
        if (child && child.exitCode === null) {
          const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()))
          child.kill()
          await exited
        }
        await rootServer?.close()
        await Promise.all([...watchers].map((watcher) => watcher.close()))
        await implementationServer?.close()
        await rpc.close()
      })
      const mainFile = `main.${format === 'es' ? 'mjs' : 'cjs'}`
      await writeFiles(root, {
        'main.ts': `
          import { app, BrowserWindow, ipcMain } from 'electron'
          import { counter } from './users'
          import { counter as viaBarrel } from './barrel'
          import * as namespace from './users'
          import { getRuntime } from 'virtual:a0-bootstrap'
          app.setPath('userData', ${JSON.stringify(path.join(root, 'user-data'))})
          app.whenReady().then(async () => {
            ipcMain.handle('a0:invoke', async (event, moduleKey, exportName, input) =>
              (await getRuntime()).invoke({ caller: 'renderer', moduleKey, exportName }, event, input))
            const window = new BrowserWindow({ show: false, webPreferences: {
              preload: ${JSON.stringify(path.join(root, 'out/preload.cjs'))}, sandbox: true, contextIsolation: true,
            } })
            await window.loadURL('data:text/html,<title>A0</title>')
            process.on('message', async ({ id, action, name }) => {
              try {
                const result = action === 'local' ? await counter() : action === 'barrel' ? await viaBarrel()
                  : action === 'namespace' ? await namespace[name || 'counter']()
                  : action === 'keys' ? { names: Object.keys(namespace), pid: process.pid }
                  : await window.webContents.executeJavaScript('window.__a0.invoke(' + JSON.stringify(${JSON.stringify(moduleKey)}) + ', \"counter\")')
                process.send({ id, result: { ...result, windowId: window.id } })
              } catch (error) { process.send({ id, error: error.message }) }
            })
            process.send({ ready: true })
          }).catch(error => { console.error(error); app.exit(1) })
        `,
      })
      let runtimeReady = false
      function onstart() {
        if (stopped) return
        builds.starts++
        if (child) return
        const env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        child = spawn(binary!, [path.join(root, 'out', mainFile)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
        child.stdout?.on('data', (data) => { log += data })
        child.stderr?.on('data', (data) => { log += data })
        child.on('error', (error) => { log += String(error) })
        child.on('message', (message: any) => { if (message.ready) runtimeReady = true })
      }
      const mainPlugin: Plugin = {
        name: 'a0:main',
        enforce: 'pre',
        configResolved() { builds.configured++ },
        async buildStart() {
          if (!implementationServer) {
            const target = this.environment
            const top = target.getTopLevelConfig()
            implementationServer = await createServer({
              configFile: false, root, publicDir: false, appType: 'custom', logLevel: 'silent',
              server: { middlewareMode: true, ws: false, watch: { ignored: ['**/out/**', '**/user-data/**'] } },
              resolve: { alias: [...top.resolve.alias, ...Object.entries(target.config.build.rolldownOptions.resolve?.alias ?? {}).flatMap(([find, replacement]) => typeof replacement === 'string' ? [{ find, replacement }] : [])] },
              environments: { ipc_invoke: {
                consumer: 'server', keepProcessEnv: true,
                resolve: { conditions: target.config.resolve.conditions, builtins: [...target.config.resolve.builtins, 'electron'], external: ['electron'] },
                dev: { moduleRunnerTransform: true, createEnvironment(name, config) {
                  return new DevEnvironment(name, config, { hot: false })
                } },
              } },
              plugins: [{
                name: 'a0:implementation',
                applyToEnvironment: (environment) => environment.name === 'ipc_invoke',
                async hotUpdate(context) {
                  if (context.file !== moduleKey && context.file !== path.join(root, 'helper.ts')) return
                  for (const node of context.modules) this.environment.moduleGraph.invalidateModule(node)
                  names = (await fs.readFile(moduleKey, 'utf8')).includes('export const added') ? ['counter', 'added'] : ['counter']
                  revision++
                  return []
                },
              }],
            })
            connection = await rpc.ready
          }
        },
        resolveId: { order: 'pre', async handler(source, importer, options) {
          if (source === 'virtual:a0-bootstrap') return '\0a0:bootstrap'
          if (source.startsWith('\0')) return
          const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
          if (resolved?.id === moduleKey) return '\0a0:caller'
        } },
        load(id) {
          if (id === '\0a0:bootstrap') return `let promise;
            export function getRuntime() { return promise ??= import(${JSON.stringify(pathToFileURL(runtimeFile).href)}).then(async m => {
              await m.initRuntime(${JSON.stringify(connection)});
              return m.getRuntime();
            }) }`
          if (id === '\0a0:caller') return `import { getRuntime } from 'virtual:a0-bootstrap'; export const counter = async input => (await getRuntime()).invoke(${JSON.stringify({ caller: 'main', moduleKey, exportName: 'counter' })}, undefined, input)`
        },
        closeBundle() { builds.main++ },
      }
      const preloadPlugin: Plugin = {
        name: 'a0:preload',
        transform(code, id) {
          if (id === path.join(root, 'preload.ts')) return `import { contextBridge, ipcRenderer } from 'electron'; contextBridge.exposeInMainWorld('__a0', { invoke: (moduleKey, exportName, input) => ipcRenderer.invoke('a0:invoke', moduleKey, exportName, input) });\n${code}`
        },
        closeBundle() { builds.preload++ },
      }
      const mainBuild = {
        outDir: 'out', emptyOutDir: false,
        lib: { entry: path.join(root, 'main.ts'), formats: [format] },
        rolldownOptions: { output: { format, entryFileNames: mainFile }, external: [pathToFileURL(runtimeFile).href], resolve: { alias: {
          'electron-ipc-invoke': path.resolve('src/index.ts'), '@main-only': path.join(root, 'helper.ts'),
        } } },
      }
      const alias = [...sourceAliases, { find: '@main-only', replacement: path.join(root, 'helper.ts') }]
      const integrations = integration === 'simple'
        ? electron({ main: { entry: path.join(root, 'main.ts'), onstart, vite: { resolve: { alias }, plugins: [mainPlugin], build: mainBuild } },
            preload: { input: path.join(root, 'preload.ts'), onstart, vite: { plugins: [preloadPlugin], build: { outDir: 'out', emptyOutDir: false, rolldownOptions: { output: { entryFileNames: 'preload.cjs' } } } } } })
        : electronSimple({ main: { input: path.join(root, 'main.ts'), onstart, plugins: [mainPlugin], options: { build: mainBuild } },
            preload: { input: path.join(root, 'preload.ts'), onstart, plugins: [preloadPlugin], options: { build: { outDir: 'out', emptyOutDir: false, rolldownOptions: { output: { entryFileNames: 'preload.cjs' } } } } } })
      rootServer = await createServer({ configFile: false, root, logLevel: 'silent', plugins: [integrations], server: { host: '127.0.0.1', port: 0, ws: false } })
      await rootServer.listen()
      try { await until(() => runtimeReady, 'Electron ready') } catch (error) { throw new Error(`${error}\n${log}`) }
      let requestId = 0
      async function call(action: string, name?: string): Promise<any> {
        const id = ++requestId
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child!.off('message', listener); reject(new Error(`Call timeout\n${log}`)) }, 10000)
          function listener(message: any) {
            if (message.id !== id) return
            clearTimeout(timer)
            child!.off('message', listener)
            if (message.error) reject(new Error(message.error))
            else resolve(message.result)
          }
          child!.on('message', listener)
          child!.send({ id, action, name })
        })
      }
      const initial = await call('local')
      expect(initial).toMatchObject({ count: 1, version: 1, alias: 'main-alias', hasEvent: false })
      expect((await call('remote'))).toMatchObject({ count: 2, hasEvent: true, pid: initial.pid, windowId: initial.windowId })
      expect((await call('barrel')).count).toBe(3)
      expect((await call('namespace')).count).toBe(4)
      const initialBuilds = { ...builds }
      if (integration === 'multi-env') expect(builds.configured).toBe(0)
      await fs.writeFile(moduleKey, implementation(2))
      await until(() => revision >= 1, 'implementation invalidation')
      const updated = await call('remote')
      expect(updated).toMatchObject({ version: 2, pid: initial.pid, windowId: initial.windowId, hasHot: false })
      expect((await call('local')).count).toBe(updated.count + 1)
      expect(await call('namespace')).toMatchObject({ count: updated.count + 2, version: 2, pid: initial.pid })
      expect((await call('keys')).names).toEqual(['counter'])
      await expect(call('namespace', 'added')).rejects.toThrow()
      const beforeFailure = revision
      await fs.writeFile(moduleKey, implementation(3, true))
      await until(() => revision > beforeFailure, 'invalid implementation')
      await expect(call('local')).rejects.toThrow()
      await expect(call('remote')).rejects.toThrow()
      const failedRevision = revision
      await fs.writeFile(moduleKey, implementation(4))
      await until(() => revision > failedRevision, 'repaired implementation')
      expect(await call('local')).toMatchObject({ version: 4, pid: initial.pid })
      const priorRevision = revision
      await fs.writeFile(path.join(root, 'helper.ts'), 'export const value = "updated-alias"')
      await until(() => revision > priorRevision, 'dependency invalidation')
      expect(await call('remote')).toMatchObject({ alias: 'updated-alias', pid: initial.pid })
      const beforeRemoval = revision
      await fs.writeFile(moduleKey, implementation(5))
      await until(() => revision > beforeRemoval, 'export deletion')
      await call('local')
      expect((await call('keys')).names).toEqual(['counter'])
      await expect(call('namespace', 'added')).rejects.toThrow()
      expect(builds).toEqual(initialBuilds)
      console.log(`A0 ${integration}/${format}: PID ${initial.pid}, builds ${JSON.stringify(builds)}, shared state, update, error recovery passed`)
    })
  }
}
