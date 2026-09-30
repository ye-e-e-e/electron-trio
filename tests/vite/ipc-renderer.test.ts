import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'vite'
import type { HotPayload } from 'vite'
import { expect, test, vi } from 'vitest'
import { IpcContext } from '#/vite/ipc-plugin/context'
import { ipcRendererPlugin } from '#/vite/ipc-renderer-plugin/plugin'
import { ipcPlugins } from '../helpers'
import {
  bundle,
  cjs,
  entryCode,
  evaluate,
  fixture,
  sourceAliases,
} from '../helpers'

test.for([undefined, '__custom"\\bridge'])(
  'virtual renderer helpers use the configured bridge and reject invalid configuration: %s',
  async (bridgeName, t) => {
    const root = await fixture(t, {
      'helpers.ts':
        "export { createRendererInvoker, createDevRendererInvoker } from 'virtual:electron-start:ipc-renderer'",
    })
    const output = await bundle(
      root,
      ipcPlugins({ bridgeName }),
      'helpers.ts',
      cjs(root, 'helpers.ts'),
    )
    type InvokerFactory = (
      channel: string,
    ) => (input: unknown) => Promise<unknown>
    type Invokers = {
      createRendererInvoker: InvokerFactory
      createDevRendererInvoker: (
        moduleKey: string,
        exportName: string,
      ) => (input: unknown) => Promise<unknown>
    }
    const bridge: Record<string, unknown> = {
      ['__proto__']: async (input: unknown) => input,
      invalid: 1,
      invoke: (moduleKey: string, exportName: string, input: unknown) => [
        moduleKey,
        exportName,
        input,
      ],
    }
    const code = entryCode(output)
    const { createRendererInvoker, createDevRendererInvoker } =
      evaluate<Invokers>(
        code,
        {},
        {
          [bridgeName ?? '__ipc']: bridge,
        },
      )
    const input = [1, 'x']
    expect(await createRendererInvoker('__proto__')(input)).toBe(input)
    await expect(createRendererInvoker('toString')(undefined)).rejects.toThrow(
      /missing channel/,
    )
    await expect(createRendererInvoker('invalid')(undefined)).rejects.toThrow(
      /Invalid IPC bridge method/,
    )
    expect(
      await createDevRendererInvoker('/functions.ts', '__proto__')(input),
    ).toStrictEqual(['/functions.ts', '__proto__', input])
    bridge.invoke = 1
    await expect(
      createDevRendererInvoker('/functions.ts', 'run')(undefined),
    ).rejects.toThrow(/preload configuration/)
    const missing = evaluate<Invokers>(code)
    await expect(
      missing.createRendererInvoker('run')(undefined),
    ).rejects.toThrow(/preload configuration/)
    await expect(
      missing.createDevRendererInvoker('/functions.ts', 'run')(undefined),
    ).rejects.toThrow(/preload configuration/)
  },
)

test.for(['raw', 'url', 'raw&variant=desktop', 'variant=desktop&url'])(
  'development resource imports with ?%s bypass definition conversion',
  async (query, t) => {
    const root = await fixture(t, {
      'definition.ts':
        "import { createIpcInvoke } from 'electron-start'; export const run = createIpcInvoke('run').handler(() => 1)",
    })
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [ipcRendererPlugin(new IpcContext({}))],
      resolve: { alias: sourceAliases },
      server: { middlewareMode: true, ws: false },
      optimizeDeps: { noDiscovery: true },
    })
    t.onTestFinished(() => server.close())
    const resource = await server.transformRequest(`/definition.ts?${query}`)
    expect(resource?.code).toContain('export default')
    expect(resource?.code).not.toContain('createDevRendererInvoker')
    expect((await server.transformRequest('/definition.ts'))?.code).toContain(
      'createDevRendererInvoker',
    )
  },
)

test(
  'renderer strips implementation code and source maps and ignores undiscovered definitions',
  { timeout: 30000 },
  async (t) => {
    const definition = (channel: string) =>
      `import { createIpcInvoke } from 'electron-start'; import { z } from 'zod'; export const run = createIpcInvoke('${channel}').inputValidator(z.void()).handler(() => 'MAIN_ONLY_SENTINEL')`
    const root = await fixture(t, {
      'active.ts': definition('active'),
      'hidden.ts': 'invalid @@@',
    })
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [ipcRendererPlugin(new IpcContext({}))],
      resolve: { alias: sourceAliases },
      server: { middlewareMode: true, ws: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    })
    t.onTestFinished(() => server.close())
    const messages: HotPayload[] = []
    vi.spyOn(server.environments.client.hot, 'send').mockImplementation(
      (message) => {
        if (typeof message !== 'string') messages.push(message)
      },
    )
    const initial = await server.transformRequest('/active.ts')
    expect(initial!.code).not.toMatch(/MAIN_ONLY_SENTINEL|zod/)
    expect(JSON.stringify(initial!.map)).not.toMatch(
      /MAIN_ONLY_SENTINEL|inputValidator|zod/,
    )
    await fs.writeFile(path.join(root, 'hidden.ts'), definition('active'))
    await delay(200)
    expect(messages).toEqual([])
  },
)
