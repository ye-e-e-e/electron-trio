import fs from 'node:fs/promises'
import { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import { createServer } from 'vite'
import type { ViteDevServer } from 'vite'
import { expect, test } from 'vitest'
import type { TestContext } from 'vitest'
import { IpcContext } from '#/vite/ipc-plugin/context'
import { ipcRendererPlugin } from '#/vite/ipc-renderer-plugin/plugin'
import { bundle, cjs, entryCode, sourceAliases } from '../helpers'
import { ipcPlugins } from '../helpers'

const channels = [
  'plain',
  'x%y',
  'x%20y',
  'x y',
  '__x00__',
  '__proto__',
  '中文',
  '😀',
  'slash/name',
  'question?name',
  'hash#name',
  '\0',
  '\uD800',
]
const bridgeName = '__ipc_channel_test'

async function fixture(t: TestContext, definitionChannels = channels) {
  const root = await fs.mkdtemp(
    path.join(
      path.resolve(import.meta.dirname, '../..'),
      '.ipc-test-channels-',
    ),
  )
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'src/ipc'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'src/ipc/channels.ts'),
    `import { createIpcInvoke } from 'electron-start'; import { z } from 'zod';\n` +
      definitionChannels
        .map(
          (channel, i) =>
            `export const fn${i} = createIpcInvoke(${JSON.stringify(channel)}).inputValidator(z.unknown()).handler(({ data }) => data);`,
        )
        .join('\n'),
  )
  return root
}

// Exercise Vite's HTTP middleware, including its URL decoding, without binding a port.
function request(server: ViteDevServer, url: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk) => chunks.push(chunk))
    const req = new IncomingMessage(socket as unknown as Socket)
    req.method = 'GET'
    req.url = url
    req.headers = { host: 'localhost', 'sec-fetch-dest': 'script' }
    const res = new ServerResponse(req)
    res.assignSocket(socket as unknown as Socket)
    res.on('error', (error) => {
      socket.destroy()
      reject(error)
    })
    res.on('finish', () => {
      const response = Buffer.concat(chunks).toString()
      resolve({
        status: res.statusCode,
        body: response.slice(response.indexOf('\r\n\r\n') + 4),
      })
      socket.destroy()
    })
    server.middlewares(req, res, (error: unknown) => {
      if (error) {
        socket.destroy()
        reject(error)
      } else {
        res.statusCode = 404
        res.end('not found')
      }
    })
  })
}

test('development proxies use stable module targets regardless of channel literals', async (t) => {
  const root = await fixture(t)
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [ipcRendererPlugin(new IpcContext({ bridgeName }))],
    resolve: { alias: sourceAliases },
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  t.onTestFinished(() => server.close())
  const definition = await request(server, '/src/ipc/channels.ts')
  expect(definition.status).toBe(200)
  const urls = [...definition.body.matchAll(/from "([^"]+)"/g)].map(
    (match) => match[1],
  )
  expect(urls).toHaveLength(1)
  expect(urls[0]).toContain('virtual:electron-start:ipc-renderer')
  const runtime = await request(server, urls[0])
  expect(runtime.status).toBe(200)
  const createDevRendererInvoker = vm.runInNewContext(
    runtime.body.replaceAll('export function ', 'function ') +
      '\ncreateDevRendererInvoker',
    {
      [bridgeName]: {
        invoke: (moduleKey: string, exportName: string, input: unknown) => [
          moduleKey,
          exportName,
          input,
        ],
      },
    },
  )
  const context = { __ipcInvoke: createDevRendererInvoker } as Record<
    string,
    unknown
  >
  vm.runInNewContext(
    definition.body
      .replace(/^import[^\n]+\n/, '')
      .replaceAll(/export const (fn\d+)\s*=/g, 'globalThis.$1 ='),
    context,
  )
  for (const i of channels.keys()) {
    const invoke = context[`fn${i}`] as (input: unknown) => Promise<unknown>
    expect(await invoke('payload')).toStrictEqual([
      path.join(root, 'src/ipc/channels.ts'),
      `fn${i}`,
      'payload',
    ])
  }
})

test('production selection and preload forwarding preserve special channels', async (t) => {
  const productionChannels = channels
  const root = await fixture(t, productionChannels)
  await fs.writeFile(
    path.join(root, 'renderer.ts'),
    `export * from './src/ipc/channels'`,
  )
  await fs.writeFile(path.join(root, 'preload.ts'), '')
  const plugins = ipcPlugins({ bridgeName })
  await bundle(root, plugins, 'renderer.ts', cjs(root, 'renderer.ts'))
  const output = await bundle(
    root,
    plugins,
    'preload.ts',
    cjs(root, 'preload.ts'),
    'electron_preload',
  )
  type Bridge = Record<string, (input: unknown) => unknown>
  let bridge: Bridge = {}
  vm.runInNewContext(entryCode(output), {
    exports: {},
    require: () => ({
      contextBridge: {
        exposeInMainWorld(name: string, value: Bridge) {
          expect(name).toBe(bridgeName)
          bridge = value
        },
      },
      ipcRenderer: {
        invoke: (channel: string, input: unknown) => [channel, input],
      },
    }),
  })
  expect(Object.keys(bridge).sort()).toStrictEqual(
    [...productionChannels].sort(),
  )
  for (const channel of productionChannels)
    expect(bridge[channel]('payload')).toStrictEqual([channel, 'payload'])
})
