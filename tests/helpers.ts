import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'vite'
import type { BuildOptions, PluginOption, Rolldown } from 'vite'
import type { TestContext } from 'vitest'

export type BuildOutput = Array<Rolldown.OutputChunk | Rolldown.OutputAsset>
export type TestEvent = { sender?: { id: number } }
type Handler<Result> = (event: TestEvent, input: unknown) => Result | Promise<Result>
type Bridge = Record<string, (input: unknown) => unknown>

// Nested Vite projects resolve fixture imports to source without a library build.
export const sourceAliases = [
  { find: /^electron-ipc-invoke$/, replacement: path.resolve(import.meta.dirname, '../src/index.ts') },
]

export async function fixture(t: TestContext, files: Record<string, string> = {}) {
  const root = await fs.mkdtemp(path.join(path.resolve(import.meta.dirname, '..'), '.ipc-test-'))
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }))
  await writeFiles(root, files)
  return root
}

export async function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, code] of Object.entries(files)) {
    const file = path.join(root, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, code)
  }
}

export const ipcSource = (body: string) => `import { z } from 'zod'; import { createIpcInvoke } from 'electron-ipc-invoke';\n${body}`
export const definition = (channel: string) => `import { createIpcInvoke } from 'electron-ipc-invoke'; export const run = createIpcInvoke(${JSON.stringify(channel)}).handler(() => 1)`

export async function bundle(root: string, plugins: PluginOption, entry: string, extra: BuildOptions = {}): Promise<BuildOutput> {
  const result = await build({
    root, configFile: false, logLevel: 'silent', plugins: [plugins],
    resolve: { alias: sourceAliases },
    build: {
      write: false, minify: false, sourcemap: true,
      lib: { entry: path.join(root, entry), formats: ['es'] },
      rolldownOptions: { external: ['electron'] },
      ...extra,
    },
  })
  if (!Array.isArray(result) && !('output' in result)) throw new Error('Expected a completed build, not a watcher')
  return (Array.isArray(result) ? result : [result]).flatMap((part) => part.output)
}

export function evaluate<Exports = Record<string, (input?: unknown) => unknown>>(
  code: string, electron: object = {}, globals: Record<string, unknown> = {}, modules: Record<string, unknown> = {},
): Exports {
  const context = {
    exports: {}, ...globals,
    require(id: string) {
      if (id === 'electron') return electron
      assert.ok(Object.hasOwn(modules, id), `Unexpected runtime dependency: ${id}`)
      return modules[id]
    },
  }
  vm.runInNewContext(code, context)
  return context.exports as Exports
}

export function channels(code: string) {
  const found: string[] = []
  evaluate(code, {
    ipcMain: { handle(channel: string) { found.push(channel) }, removeHandler() {} },
    contextBridge: { exposeInMainWorld(_name: string, bridge: Bridge) { found.push(...Object.keys(bridge)) } },
    ipcRenderer: {},
  })
  return found.sort()
}

export async function until(predicate: () => unknown | Promise<unknown>, label: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

export function electronHarness<Result = unknown>() {
  const handlers = new Map<string, Handler<Result>>()
  const bridges = new Map<string, Bridge>()
  const electron = {
    app: { getVersion: () => 'test-app-version' },
    ipcMain: {
      handle(channel: string, handler: Handler<Result>) {
        if (handlers.has(channel)) throw new Error(`Existing handler: ${channel}`)
        handlers.set(channel, handler)
      },
      removeHandler(channel: string) { handlers.delete(channel) },
    },
    contextBridge: { exposeInMainWorld(name: string, bridge: Bridge) { bridges.set(name, bridge) } },
    ipcRenderer: { invoke(channel: string, input: unknown) {
      const handler = handlers.get(channel)
      assert.ok(handler, `Missing IPC handler: ${channel}`)
      return handler({ sender: { id: 1 } }, input)
    } },
  }
  return { electron, handlers, bridges }
}

export function entryCode(output: BuildOutput): string {
  const entry = output.find((item) => item.type === 'chunk' && item.isEntry)
  assert.ok(entry?.type === 'chunk', 'Expected an entry chunk')
  return entry.code
}
export const outputText = (output: BuildOutput) => output.map((item) => item.type === 'chunk' ? item.code : item.source).join('\n')
export const cjs = (root: string, entry: string): BuildOptions => ({ lib: { entry: path.join(root, entry), formats: ['cjs'] } })
