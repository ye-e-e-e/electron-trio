import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { PluginContext } from '#/context/context'
import { DEV_CHANNEL } from '#/vite/entry-plugin/constants'
import { preloadPlugin } from '#/vite/plugin'
import { bundle, cjs, definition, entryCode, evaluate, fixture } from '../helpers'

test.for(['serve', 'build'] as const)('preload rejects direct, re-exported and entry implementations in %s', async (command, t) => {
  const root = await fixture(t, {
    'definitions.ts': definition('run'),
    'barrel.ts': 'export * from "./definitions"',
    'preload.ts': 'import "./definitions"',
    'barrel-preload.ts': 'import "./barrel"',
  })
  const context = new PluginContext({})
  context.command = command
  if (command === 'build') context.publishManifest([])

  for (const entry of ['preload.ts', 'barrel-preload.ts', 'definitions.ts']) {
    await expect(bundle(root, preloadPlugin(context), entry))
      .rejects.toThrow('Do not import IPC implementation modules into preload')
  }
})

test.for(['serve', 'build'] as const)('preload preserves ordinary imports, type imports and bridge initialization in %s', async (command, t) => {
  const root = await fixture(t, {
    'definitions.ts': definition('run'),
    'helper.ts': 'export const answer = 42',
    'preload.ts': `
      import type { run } from './definitions'
      import { answer } from './helper'
      export type Invoke = typeof run
      export const value = answer
    `,
  })
  const context = new PluginContext({ bridgeName: 'desktop' })
  context.command = command
  if (command === 'build') context.publishManifest([
    { channel: 'run', exportName: 'run', moduleKey: path.join(root, 'definitions.ts'), line: 1 },
  ])
  const output = await bundle(root, preloadPlugin(context), 'preload.ts', cjs(root, 'preload.ts'))
  const invoke = vi.fn().mockResolvedValue(7)
  const exposeInMainWorld = vi.fn()
  const exports = evaluate<{ value: number }>(entryCode(output), {
    contextBridge: { exposeInMainWorld }, ipcRenderer: { invoke },
  })

  expect(exports.value).toBe(42)
  expect(exposeInMainWorld).toHaveBeenCalledTimes(1)
  const [name, bridge] = exposeInMainWorld.mock.calls[0]
  expect(name).toBe('desktop')
  if (command === 'serve') {
    await expect(bridge.invoke('/functions.ts', 'run', 1)).resolves.toBe(7)
    expect(invoke).toHaveBeenCalledExactlyOnceWith(DEV_CHANNEL, '/functions.ts', 'run', 1)
  } else {
    await expect(bridge.run(1)).resolves.toBe(7)
    expect(invoke).toHaveBeenCalledExactlyOnceWith('run', 1)
  }
})
