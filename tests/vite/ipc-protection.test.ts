import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { DEV_CHANNEL } from '#/vite/ipc-entry-plugin/constants'
import { ipcEntryPlugin } from '#/vite/ipc-entry-plugin/plugin'
import { IpcContext } from '#/vite/ipc-plugin/context'
import { ipcProtectionPlugin } from '#/vite/ipc-protection-plugin/plugin'
import {
  bundle,
  cjs,
  definition,
  entryCode,
  evaluate,
  fixture,
} from '../helpers'

test.for(['development', 'production'] as const)(
  'preload rejects direct, re-exported and entry implementations in %s mode',
  async (mode, t) => {
    const root = await fixture(t, {
      'definitions.ts': definition('run'),
      'barrel.ts': 'export * from "./definitions"',
      'preload.ts': 'import "./definitions"',
      'barrel-preload.ts': 'import "./barrel"',
    })
    const context = new IpcContext({})
    if (mode !== 'development') context.manifest.publish([])

    for (const entry of ['preload.ts', 'barrel-preload.ts', 'definitions.ts']) {
      await expect(
        bundle(
          root,
          [ipcProtectionPlugin(context), ipcEntryPlugin(context)],
          entry,
          {},
          'electron_preload',
          mode,
        ),
      ).rejects.toThrow('Do not import IPC implementation modules into preload')
    }
  },
)

test.for(['development', 'production', 'staging'] as const)(
  'preload preserves ordinary imports, type imports and bridge initialization in %s mode',
  async (mode, t) => {
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
    const context = new IpcContext({ bridgeName: 'desktop' })
    if (mode !== 'development')
      context.manifest.publish([
        {
          channel: 'run',
          exportName: 'run',
          moduleKey: path.join(root, 'definitions.ts'),
          line: 1,
        },
      ])
    const output = await bundle(
      root,
      [ipcProtectionPlugin(context), ipcEntryPlugin(context)],
      'preload.ts',
      cjs(root, 'preload.ts'),
      'electron_preload',
      mode,
    )
    const invoke = vi.fn().mockResolvedValue(7)
    const exposeInMainWorld = vi.fn()
    const exports = evaluate<{ value: number }>(entryCode(output), {
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke },
    })

    expect(exports.value).toBe(42)
    expect(exposeInMainWorld).toHaveBeenCalledTimes(1)
    const [name, bridge] = exposeInMainWorld.mock.calls[0]
    expect(name).toBe('desktop')
    if (mode === 'development') {
      await expect(bridge.invoke('/functions.ts', 'run', 1)).resolves.toBe(7)
      expect(invoke).toHaveBeenCalledExactlyOnceWith(
        DEV_CHANNEL,
        '/functions.ts',
        'run',
        1,
      )
    } else {
      await expect(bridge.run(1)).resolves.toBe(7)
      expect(invoke).toHaveBeenCalledExactlyOnceWith('run', 1)
    }
  },
)
