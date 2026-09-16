import { expect, test, vi } from 'vitest'
import type { TestContext } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { IncomingMessage, ServerResponse } from 'node:http'
import vm from 'node:vm'
import { createServer } from 'vite'
import type { ViteDevServer } from 'vite'
import type { Socket } from 'node:net'
import { bundle, cjs, entryCode, sourceAliases } from './helpers'
import { ipcInvoke } from '#/vite'
import { createRendererInvoker } from '#/renderer'

const channels = ['plain', 'x%y', 'x%20y', 'x y', '__x00__', '__proto__', '中文', '😀',
  'slash/name', 'question?name', 'hash#name', '\0']
const bridgeName = '__ipc_channel_test'

async function fixture(t: TestContext, definitionChannels = channels) {
  const root = await fs.mkdtemp(path.join(path.resolve(import.meta.dirname, '..'), '.ipc-test-channels-'))
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'src/ipc'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/ipc/channels.ipc.ts'),
    `import { createIpcInvoke } from 'electron-ipc-invoke'; import { z } from 'zod';\n` +
    definitionChannels.map((channel, i) => `export const fn${i} = createIpcInvoke(${JSON.stringify(channel)}).inputValidator(z.unknown()).handler(({ data }) => data);`).join('\n'))
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
    res.on('error', (error) => { socket.destroy(); reject(error) })
    res.on('finish', () => {
      const response = Buffer.concat(chunks).toString()
      resolve({ status: res.statusCode, body: response.slice(response.indexOf('\r\n\r\n') + 4) })
      socket.destroy()
    })
    server.middlewares(req, res, (error: unknown) => {
      if (error) { socket.destroy(); reject(error) }
      else { res.statusCode = 404; res.end('not found') }
    })
  })
}

test('development proxy requests preserve every channel through Vite URL decoding', async (t) => {
  const root = await fixture(t)
  const server = await createServer({
    root, configFile: false, logLevel: 'silent', plugins: [ipcInvoke({ bridgeName })[0]],
    resolve: { alias: sourceAliases },
    server: { middlewareMode: true, ws: false }, optimizeDeps: { noDiscovery: true, include: [] },
  })
  t.onTestFinished(() => server.close())
  vi.stubGlobal(bridgeName, Object.fromEntries(channels.map((channel) => [channel, (input: unknown) => [channel, input]])))
  const definition = await request(server, '/src/ipc/channels.ipc.ts')
  expect(definition.status).toBe(200)
  const urls = [...definition.body.matchAll(/from "([^"]+)"/g)].map((match) => match[1])
  expect(urls.length).toBe(channels.length)
  expect(new Set(urls).size).toBe(channels.length)
  for (const [i, url] of urls.entries()) {
    const proxy = await request(server, url)
    expect(proxy.status, `proxy request for ${JSON.stringify(channels[i])}`).toBe(200)
    const context: { createRendererInvoker: typeof createRendererInvoker; invoke?: (input: unknown) => Promise<unknown> } = { createRendererInvoker }
    vm.runInNewContext(proxy.body.replace(/^import[^\n]+\n/, '').replace('export const invoke =', 'globalThis.invoke ='), context)
    expect(await context.invoke!('payload')).toStrictEqual([channels[i], 'payload'])
  }
})

test('production selection and preload forwarding preserve special channels', async (t) => {
  const productionChannels = [...channels, '\uD800']
  const root = await fixture(t, productionChannels)
  await fs.writeFile(path.join(root, 'renderer.ts'), `export * from './src/ipc/channels.ipc'`)
  await fs.writeFile(path.join(root, 'preload.ts'), '')
  const [rendererPlugin, , preloadPlugin] = ipcInvoke({ bridgeName })
  await bundle(root, rendererPlugin, 'renderer.ts', cjs(root, 'renderer.ts'))
  const output = await bundle(root, preloadPlugin, 'preload.ts', cjs(root, 'preload.ts'))
  type Bridge = Record<string, (input: unknown) => unknown>
  let bridge: Bridge = {}
  vm.runInNewContext(entryCode(output), {
    exports: {},
    require: () => ({
      contextBridge: { exposeInMainWorld(name: string, value: Bridge) { expect(name).toBe(bridgeName); bridge = value } },
      ipcRenderer: { invoke: (channel: string, input: unknown) => [channel, input] },
    }),
  })
  expect(Object.keys(bridge).sort()).toStrictEqual([...productionChannels].sort())
  for (const channel of productionChannels) expect(bridge[channel]('payload')).toStrictEqual([channel, 'payload'])
})
