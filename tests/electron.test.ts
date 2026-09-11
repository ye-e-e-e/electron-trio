// Optional real Electron test: ELECTRON_BINARY=/path/to/electron pnpm test:electron
import { expect, test } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'vite'
import { ipcInvoke } from '#/vite'
import { sourceAliases } from './helpers'

const binary = process.env.ELECTRON_BINARY
if (!binary) throw new Error('Set ELECTRON_BINARY to an installed Electron executable')
for (const mode of [
    { name: 'esm-bundled', mainFormat: 'es', mainFile: 'main.mjs', externalRuntime: false },
    { name: 'cjs-external', mainFormat: 'cjs', mainFile: 'main.cjs', externalRuntime: true },
  ] as const) {
  test(`Electron IPC with ${mode.name}`, { timeout: 45000 }, async (t) => {
    const root = await fs.mkdtemp(path.join(path.resolve(import.meta.dirname, '..'), '.ipc-test-electron-'))
    t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }))
    const outDir = `out-${mode.name}`
    const files = {
      'src/ipc/smoke.ipc.ts': `import { z } from 'zod'; import { createIpcInvoke } from 'electron-ipc-invoke'
        export const version = createIpcInvoke('version').handler(({ data }) => {
          if (data !== undefined) throw new Error('Unexpected data without an input validator')
          return process.versions.electron
        })
        export const sum = createIpcInvoke('sum').inputValidator(z.object({ a: z.string().transform(async (value) => Number(value)), b: z.number().default(3) })).handler(({ event, data }) => ({ sum: data.a + data.b, hasEvent: !!event?.sender, senderUrl: event?.senderFrame?.url }))
        export const fail = createIpcInvoke('fail').handler(() => { throw new Error('expected failure') })`,
      'renderer.ts': `import { version, sum, fail } from './src/ipc/smoke.ipc'
        export async function run() {
          await (version as (input: unknown) => Promise<string>)({ undeclared: true })
          let errorRejected = false
          try { await fail() } catch { errorRejected = true }
          let validationRejected = false; try { await sum({ a: 2 } as any) } catch { validationRejected = true }; return { version: await version(), remote: await sum({ a: '2' }), validationRejected, errorRejected }
        }`,
      'preload.ts': ``,
      'main.ts': `import { sum } from './src/ipc/smoke.ipc'; import { app, BrowserWindow } from 'electron'
        import path from 'node:path'
        import { fileURLToPath } from 'node:url'
        const directory = ${mode.externalRuntime ? '__dirname' : 'path.dirname(fileURLToPath(import.meta.url))'}
        let window: BrowserWindow
        app.setPath('userData', path.join(directory, 'user-data'))
        app.whenReady().then(async () => {
          try {
            window = new BrowserWindow({ show: false, webPreferences: {
              preload: path.join(directory, 'preload.mjs'), sandbox: true,
              contextIsolation: true, nodeIntegration: false,
            } })
            await window.loadFile(path.join(directory, 'index.html'))
            const result = await window.webContents.executeJavaScript('Smoke.run()')
            result.direct = await sum({ a: '2' }); console.log('IPC_SMOKE_RESULT:' + JSON.stringify(result))
            window.destroy()
            app.exit(0)
          } catch (error) { console.error(error); app.exit(1) }
        })`,
    }
    for (const [name, code] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
      await fs.writeFile(path.join(root, name), code)
    }
    const ipc = ipcInvoke()
    for (const target of ['renderer', 'main', 'preload'] as const) {
      const format = target === 'renderer' ? 'iife' : target === 'main' ? mode.mainFormat : 'cjs'
      const fileName = target === 'main' ? mode.mainFile : target === 'preload' ? 'preload.mjs' : 'renderer.js'
      await build({
        root, configFile: false, logLevel: 'silent', plugins: [ipc[target]()],
        resolve: { alias: sourceAliases },
        build: {
          outDir, emptyOutDir: false, minify: false,
          lib: { entry: path.join(root, `${target}.ts`), formats: [format], name: 'Smoke', fileName: () => fileName },
          rolldownOptions: { external: ['electron', 'node:path', 'node:url', ...(mode.externalRuntime ? ['electron-ipc-invoke'] : [])] },
        },
      })
    }
    if (mode.externalRuntime) {
      const mainCode = await fs.readFile(path.join(root, outDir, mode.mainFile), 'utf8')
      expect(mainCode).toMatch(/require\(["']electron-ipc-invoke["']\)/)
    }
    await fs.writeFile(path.join(root, outDir, 'index.html'), `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'"><script src="./renderer.js"></script>`)
    const output = await new Promise<string>((resolve, reject) => {
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(binary!, [path.join(root, outDir, mode.mainFile)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let log = ''
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Electron smoke test timed out\n${log}`)) }, 20000)
      child.stdout.on('data', (chunk) => { log += chunk })
      child.stderr.on('data', (chunk) => { log += chunk })
      child.on('error', (error) => { clearTimeout(timeout); reject(error) })
      child.on('close', (code) => {
        clearTimeout(timeout)
        if (code !== 0) reject(new Error(`Electron exited with ${code}\n${log}`))
        else resolve(log)
      })
    })
    const match = output.match(/IPC_SMOKE_RESULT:(\{[^\n]+\})/)
    expect(match, output).not.toBeNull()
    const result = JSON.parse(match![1])
    expect(typeof result.version).toBe('string')
    expect(result.remote.sum).toBe(5)
    expect(result.remote.hasEvent).toBe(true)
    expect(result.remote.senderUrl).toMatch(/^file:/)
    expect(result.direct).toStrictEqual({ sum: 5, hasEvent: false })
    expect(result.validationRejected).toBe(true)
    expect(result.errorRejected).toBe(true)
    console.log(`Electron ${result.version} (${mode.name}): sandboxed preload, renderer proxy and error propagation passed`)
  })
}
