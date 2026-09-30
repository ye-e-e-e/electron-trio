import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { expect, test } from 'vitest'
import type { ElectronDevEnvironment } from '#/vite/electron-plugin/environment'
import { fixture, sourceAliases, until } from '../helpers'

test(
  'integrated main runner, IPC calls, dependency HMR and preload watch',
  { timeout: 60000 },
  async (t) => {
    const root = await fixture(t, {
      'package.json':
        '{"type":"module","name":"runner-test","version":"1.2.3"}',
      'index.html': '<script type="module" src="/renderer.ts"></script>',
      'renderer.ts': `import { counter } from './functions'; globalThis.counter = counter`,
      'state.ts': 'export const state = { count: 0 }',
      'functions.ts': `import { createIpcInvoke } from 'electron-start'; import { state } from './state'; export const counter = createIpcInvoke('count').handler(({event}) => ({ count: ++state.count, version: 1, event: !!event }))`,
      'message.ts': `export const message = 'first'`,
      'preload-value.ts': `export const version = 1`,
      'preload.ts': `import { createPreload } from 'electron-start'; import { contextBridge } from 'electron'; import { version } from './preload-value'; import 'virtual:test-preload'; export default createPreload(() => contextBridge.exposeInMainWorld('preloadVersion', version))`,
      'vite.config.ts': `
      import { electronStart } from ${JSON.stringify(path.resolve(import.meta.dirname, '../../dist/vite.mjs'))}
      export default {
        logLevel: 'warn',
        resolve: { alias: [{ find: /^electron-start$/, replacement: ${JSON.stringify(sourceAliases[0].replacement)} }] },
        plugins: [electronStart({ entry: 'main.ts' }), {
          name: 'test:preload-plugin', applyToEnvironment: environment => environment.name === 'electron_preload',
          resolveId(id) { if (id === 'virtual:test-preload') return '\\0test-preload' },
          load(id) { if (id === '\\0test-preload') return 'console.log("preload plugin applied")' },
        }],
      }`,
      'main.ts': `import { app, BrowserWindow } from 'electron'
      import { loadWindow } from 'electron-start'
      import preload from './preload'
      import { counter } from './functions'
      import * as calls from './functions'
      import { state } from './state'
      import { message } from './message'
      import path from 'node:path'
      let win; let title = message
      globalThis.boots = (globalThis.boots ?? 0) + 1
      app.setPath('userData', path.join(process.cwd(), 'user-data'))
      app.whenReady().then(async () => {
        state.count = 10
        win = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } })
        await loadWindow(win)
        process.on('message', async request => {
          if (request.type !== 'test:call') return
          try {
            const value = request.route === 'main' ? await counter() : request.route === 'renderer' ? await win.webContents.executeJavaScript('counter()') : request.route === 'preload' ? { version: await win.webContents.executeJavaScript('globalThis.preloadVersion') } : { title, exports: Object.keys(calls), boots: globalThis.boots, appName: app.getName(), appVersion: app.getVersion() }
            process.send({ type: 'test:result', id: request.id, result: { ...value, pid: process.pid, windowId: win.id } })
          } catch (error) { process.send({ type: 'test:result', id: request.id, error: error.message }) }
        })
        process.send({ type: 'test:ready' })
      })
      if (import.meta.hot) import.meta.hot.accept('./message', module => { title = module.message })`,
    })
    const server = await createServer({
      root,
      server: {
        host: '127.0.0.1',
        port: 0,
        watch: { ignored: ['**/user-data/**'] },
      },
    })
    t.onTestFinished(() => server.close())
    await server.listen()
    const environment = server.environments
      .electron_main as ElectronDevEnvironment
    await until(() => environment.electron.child, 'Electron spawned')
    let child = environment.electron.child!
    await expect(
      fs.access(path.join(root, 'dist/main/main.mjs')),
    ).rejects.toThrow()
    let ready = false
    child.on('message', (message: any) => {
      if (message.type === 'test:ready') ready = true
    })
    await until(() => ready, 'Electron window ready')
    let sequence = 0
    const call = (route: string) =>
      new Promise<any>((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => {
          child.off('message', listener)
          reject(new Error('Electron call timed out'))
        }, 5000)
        function listener(message: any) {
          if (message.type !== 'test:result' || message.id !== id) return
          clearTimeout(timer)
          child.off('message', listener)
          if (message.error) reject(new Error(message.error))
          else resolve(message.result)
        }
        child.on('message', listener)
        child.send({ type: 'test:call', id, route })
      })
    const initial = await call('main')
    expect(await call('preload')).toMatchObject({
      version: 1,
      pid: initial.pid,
      windowId: initial.windowId,
    })
    expect(initial).toMatchObject({ count: 11, version: 1, event: false })
    expect(await call('renderer')).toMatchObject({
      count: 12,
      event: true,
      pid: initial.pid,
    })
    const functions = path.join(root, 'functions.ts')
    await fs.writeFile(
      functions,
      (await fs.readFile(functions, 'utf8')).replace(
        'version: 1',
        'version: 2',
      ),
    )
    await until(
      async () => (await call('renderer')).version === 2,
      'IPC implementation HMR',
    )
    expect(await call('main')).toMatchObject({
      version: 2,
      pid: initial.pid,
      windowId: initial.windowId,
    })
    await fs.writeFile(
      path.join(root, 'message.ts'),
      `export const message = 'updated'`,
    )
    await until(
      async () => (await call('status')).title === 'updated',
      'ordinary dependency HMR',
    )
    expect(environment.electron.child).toBe(child)
    expect(await call('status')).toMatchObject({
      boots: 1,
      appName: 'runner-test',
      appVersion: '1.2.3',
    })
    await fs.writeFile(
      path.join(root, 'preload-value.ts'),
      `export const version = 2`,
    )
    await until(async () => {
      try {
        return (await call('preload')).version === 2
      } catch {
        return false
      }
    }, 'preload rebuild and window reload')
    expect(await call('preload')).toMatchObject({
      version: 2,
      pid: initial.pid,
      windowId: initial.windowId,
    })
    await fs.writeFile(
      path.join(root, 'preload.ts'),
      `import { createPreload } from 'electron-start'; import { contextBridge } from 'electron'; export default createPreload(() => contextBridge.exposeInMainWorld('preloadVersion', 3))`,
    )
    await until(async () => {
      try {
        return (await call('preload')).version === 3
      } catch {
        return false
      }
    }, 'preload entry rebuild')
    expect(await call('preload')).toMatchObject({
      version: 3,
      pid: initial.pid,
      windowId: initial.windowId,
    })
    expect(await call('renderer')).toMatchObject({
      version: 2,
      pid: initial.pid,
    })

    // An export change invalidates the static main proxy. With no accepting
    // importer, the process is restarted instead of rerunning app side effects.
    await fs.appendFile(
      functions,
      `\nexport const added = createIpcInvoke('added').handler(() => 3)`,
    )
    await until(
      () => environment.electron.child && environment.electron.child !== child,
      'Electron restart after proxy export change',
    )
    child = environment.electron.child!
    ready = false
    child.on('message', (message: any) => {
      if (message.type === 'test:ready') ready = true
    })
    await until(() => ready, 'restarted Electron ready')
    expect(await call('status')).toMatchObject({
      exports: expect.arrayContaining(['counter', 'added']),
      boots: 1,
    })
    expect(child.pid).not.toBe(initial.pid)
    const previous = child
    await server.close()
    expect(previous.exitCode !== null || previous.signalCode !== null).toBe(
      true,
    )
    expect(environment.electron.child).toBeUndefined()
  },
)
