import { expect, test } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'vite'
import type { Plugin, ViteDevServer } from 'vite'
import electron from 'vite-plugin-electron/simple'
import { electronSimple } from 'vite-plugin-electron/multi-env'
import { fixture, until, writeFiles } from '../helpers'

const binary = process.env.ELECTRON_BINARY
if (!binary) throw new Error('Set ELECTRON_BINARY to an installed Electron executable')

for (const integration of ['simple', 'multi-env'] as const) {
  for (const format of ['es', 'cjs'] as const) {
    test(`development plugin runner: ${integration}, ${format}`, { timeout: 60000 }, async t => {
      const root = await fixture(t, {
        'package.json': JSON.stringify({ type: 'module' }),
        'index.html': '<!doctype html><title>IPC</title>',
        'helper.ts': 'export const value = "main-alias"',
        'barrel.ts': 'export { counter } from "./users"',
        'preload.ts': '',
      })
      await fs.mkdir(path.join(root, 'node_modules'), { recursive: true })
      const packageRoot = path.join(root, 'node_modules/electron-ipc-invoke')
      await fs.mkdir(packageRoot)
      await fs.copyFile(path.resolve('package.json'), path.join(packageRoot, 'package.json'))
      await fs.cp(path.resolve('dist'), path.join(packageRoot, 'dist'), { recursive: true })
      const { ipcInvoke } = await import(pathToFileURL(path.join(packageRoot, 'dist/vite.mjs')).href)
      const moduleKey = path.join(root, 'users.ts')
      const implementation = (version: number, invalid = false, channel = 'counter') => `
        import { createIpcInvoke } from 'electron-ipc-invoke'
        import { app } from 'electron'
        import { value } from '@main-only'
        let count = 0
        ${invalid ? 'invalid syntax @@@' : ''}
        export const counter = createIpcInvoke(${JSON.stringify(channel)}).handler(({ event }) => ({
          count: ++count, version: ${version}, alias: value, electron: app.getName(),
          hasEvent: !!event?.sender, pid: process.pid, hasHot: import.meta.hot !== undefined,
        }))
        ${version >= 2 && version < 5 ? `export const added = createIpcInvoke('added').handler(() => ({ count: ++count, version: ${version}, pid: process.pid }))` : ''}
      `
      await fs.writeFile(moduleKey, implementation(1))
      const mainFile = `main.${format === 'es' ? 'mjs' : 'cjs'}`
      await writeFiles(root, {
        'main.ts': `
          import { app, BrowserWindow } from 'electron'
          import { counter } from './users'
          import { counter as viaBarrel } from './barrel'
          import * as namespace from './users'
          app.setPath('userData', ${JSON.stringify(path.join(root, 'user-data'))})
          app.whenReady().then(async () => {
            const window = new BrowserWindow({ show: false, webPreferences: {
              preload: ${JSON.stringify(path.join(root, 'out/preload.cjs'))}, sandbox: true, contextIsolation: true,
            } })
            await window.loadURL('data:text/html,<title>IPC</title>')
            process.on('message', async ({ id, action, name }) => {
              try {
                const remoteModule = name === 'fresh' ? ${JSON.stringify(path.join(root, 'new-module.ts'))} : ${JSON.stringify(moduleKey)}
                const result = action === 'local' ? await counter() : action === 'barrel' ? await viaBarrel()
                  : action === 'namespace' ? await namespace[name || 'counter']()
                  : action === 'keys' ? { names: Object.keys(namespace), pid: process.pid }
                  : await window.webContents.executeJavaScript('window.__ipc.invoke(' + JSON.stringify(remoteModule) + ', ' + JSON.stringify(name || 'counter') + ')')
                process.send({ id, result: { ...result, windowId: window.id } })
              } catch (error) { process.send({ id, error: error.message }) }
            })
            process.send({ ready: true })
          }).catch(error => { console.error(error); app.exit(1) })
        `,
      })
      let rootServer: ViteDevServer | undefined
      let child: ChildProcess | undefined
      let stopped = false
      let ready = false
      let log = ''
      const counts = { main: 0, preload: 0, starts: 0 }
      t.onTestFinished(async () => {
        stopped = true
        if (child && child.exitCode === null) {
          const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()))
          child.kill()
          await exited
        }
        await rootServer?.close()
      })
      function onstart() {
        if (stopped) return
        counts.starts++
        if (child) return
        const env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        child = spawn(binary!, [path.join(root, 'out', mainFile)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
        child.stdout?.on('data', data => { log += data })
        child.stderr?.on('data', data => { log += data })
        child.on('error', error => { log += String(error) })
        child.on('message', (message: any) => { if (message.ready) ready = true })
      }
      const [rendererPlugin, mainPlugin, preloadPlugin] = ipcInvoke()
      const counter = (target: 'main' | 'preload'): Plugin => ({ name: `test:${target}`, closeBundle() { counts[target]++ } })
      const alias = [{ find: '@main-only', replacement: path.join(root, 'helper.ts') }]
      const mainBuild = {
        outDir: 'out', emptyOutDir: false,
        lib: { entry: path.join(root, 'main.ts'), formats: [format] },
        // An explicit output array avoids merging the plugin's default ES format into this build.
        rolldownOptions: { output: [{ format, entryFileNames: mainFile }], resolve: { alias: {
          '@main-only': path.join(root, 'helper.ts'),
        } } },
      }
      const integrations = integration === 'simple'
        ? electron({ main: { entry: path.join(root, 'main.ts'), onstart, vite: { resolve: { alias }, plugins: [mainPlugin, counter('main')], build: mainBuild } },
            preload: { input: path.join(root, 'preload.ts'), onstart, vite: { plugins: [preloadPlugin, counter('preload')], build: { outDir: 'out', emptyOutDir: false, rolldownOptions: { output: { entryFileNames: 'preload.cjs' } } } } } })
        : electronSimple({ main: { input: path.join(root, 'main.ts'), onstart, plugins: [mainPlugin, counter('main')], options: { build: mainBuild } },
            preload: { input: path.join(root, 'preload.ts'), onstart, plugins: [preloadPlugin, counter('preload')], options: { build: { outDir: 'out', emptyOutDir: false, rolldownOptions: { output: { entryFileNames: 'preload.cjs' } } } } } })
      rootServer = await createServer({ configFile: false, root, logLevel: 'silent', resolve: { alias }, plugins: [rendererPlugin, integrations], server: { host: '127.0.0.1', port: 0, ws: false }, optimizeDeps: { noDiscovery: true } })
      await rootServer.listen()
      try { await until(() => ready, 'Electron ready') } catch (error) { throw new Error(`${error}\n${log}`) }
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
      await expect(call('remote')).rejects.toThrow(/Unknown IPC export/)
      await rootServer.transformRequest('/users.ts')
      expect(await call('remote')).toMatchObject({ count: 2, hasEvent: true, pid: initial.pid, windowId: initial.windowId })
      expect((await call('barrel')).count).toBe(3)
      expect((await call('namespace')).count).toBe(4)
      const initialCounts = { ...counts }
      await fs.writeFile(moduleKey, implementation(2))
      await until(async () => (await call('local')).version === 2, 'implementation update')
      expect(await call('namespace')).toMatchObject({ version: 2, pid: initial.pid })
      expect((await call('keys')).names).toEqual(['counter'])
      await expect(call('namespace', 'added')).rejects.toThrow()
      expect(await call('remote')).toMatchObject({ version: 2, hasEvent: true, pid: initial.pid, windowId: initial.windowId, hasHot: false })
      await fs.writeFile(moduleKey, implementation(3, true))
      await until(async () => { try { await call('local'); return false } catch { return true } }, 'invalid implementation')
      await expect(call('remote')).rejects.toThrow()
      await fs.writeFile(moduleKey, implementation(4))
      await until(async () => { try { return (await call('local')).version === 4 } catch { return false } }, 'implementation repair')
      await fs.writeFile(path.join(root, 'helper.ts'), 'export const value = "updated-alias"')
      await until(async () => (await call('remote')).alias === 'updated-alias', 'dependency update')
      await fs.writeFile(moduleKey, implementation(5))
      await until(async () => (await call('local')).version === 5, 'export deletion')
      expect((await call('keys')).names).toEqual(['counter'])
      await expect(call('namespace', 'added')).rejects.toThrow()
      await fs.writeFile(path.join(root, 'new-module.ts'), `
        import { createIpcInvoke } from 'electron-ipc-invoke'
        export const fresh = createIpcInvoke('fresh').handler(({ event }) => ({ fresh: true, pid: process.pid, hasEvent: !!event?.sender }))
      `)
      await expect(call('remote', 'fresh')).rejects.toThrow(/Unknown IPC export/)
      await rootServer.transformRequest('/new-module.ts')
      expect(await call('remote', 'fresh')).toMatchObject({ fresh: true, hasEvent: true, pid: initial.pid, windowId: initial.windowId })

      await fs.writeFile(moduleKey, implementation(6, false, 'renamed-counter'))
      await until(async () => (await call('local')).version === 6, 'channel rename preserves local proxy')
      await expect(call('remote', 'renamed-counter')).rejects.toThrow(/Unknown IPC export/)
      expect(await call('remote', 'counter')).toMatchObject({ version: 6, hasEvent: true, pid: initial.pid })
      expect(await call('barrel')).toMatchObject({ version: 6, pid: initial.pid })

      await fs.unlink(moduleKey)
      await until(async () => { try { await call('local'); return false } catch { return true } }, 'definition file deletion')
      await expect(call('namespace', 'counter')).rejects.toThrow()
      await expect(call('remote', 'counter')).rejects.toThrow()
      await fs.writeFile(moduleKey, implementation(7, false, 'renamed-counter'))
      await until(async () => { try { return (await call('local')).version === 7 } catch { return false } }, 'definition file restoration')
      await rootServer.transformRequest('/users.ts')
      expect(await call('remote', 'counter')).toMatchObject({ version: 7, pid: initial.pid, windowId: initial.windowId })
      expect(counts).toEqual(initialCounts)
      console.log(`Development ${integration}/${format}: stable PID ${initial.pid}, builds ${JSON.stringify(counts)}`)
    })
  }
}
