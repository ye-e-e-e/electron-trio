import { Buffer } from 'node:buffer'
import MagicString from 'magic-string'
import type { HandlerMeta } from './compiler.js'
import { HANDLER_KEY } from './runtime-key.js'

export const PROXY = '\0electron-ipc-invoke:proxy:'
export const ENTRY = 'virtual:electron-ipc-invoke:entry:'
// Hex avoids Vite URL decoding and placeholders; UTF-16 preserves all JS strings.
const encodeChannel = (channel: string) => Buffer.from(channel, 'utf16le').toString('hex')
export const decodeChannel = (encoded: string) => Buffer.from(encoded, 'hex').toString('utf16le')

export function mainModule(handlers: readonly HandlerMeta[]): string {
  return [
    'import { ipcMain } from "electron";',
    ...handlers.map(({ name, file }, index) => `import { ${name} as ipc${index} } from ${JSON.stringify(file)};`),
    `const handlers = [${handlers.map(({ channel }, index) => `[${JSON.stringify(channel)}, ipc${index}]`).join(', ')}];`,
    'const registered = [];',
    'try {',
    '  for (const [channel, invoke] of handlers) {',
    `    const execute = invoke[Symbol.for(${JSON.stringify(HANDLER_KEY)})];`,
    '    if (typeof execute !== "function") throw new TypeError(`Invalid IPC definition: ${channel}`);',
    '    ipcMain.handle(channel, execute);',
    '    registered.push(channel);',
    '  }',
    '} catch (error) {',
    '  for (const channel of registered) ipcMain.removeHandler(channel);',
    '  throw error;',
    '}',
  ].join('\n')
}

export function preloadModule(handlers: readonly HandlerMeta[], bridgeName: string): string {
  return [
    'import { contextBridge, ipcRenderer } from "electron";',
    `contextBridge.exposeInMainWorld(${JSON.stringify(bridgeName)}, {`,
    // Computed keys keep "__proto__" an ordinary own property.
    ...handlers.map(({ channel }) => `[${JSON.stringify(channel)}]: (input) => ipcRenderer.invoke(${JSON.stringify(channel)}, input),`),
    '});',
  ].join('\n')
}

export function proxyModule(channel: string, bridgeName: string): string {
  return `import { createRendererInvoker } from "electron-ipc-invoke/renderer";\nexport const invoke = /*#__PURE__*/ createRendererInvoker(${JSON.stringify(channel)}, ${JSON.stringify(bridgeName)});`
}

export function definitionModule(handlers: readonly HandlerMeta[], file: string) {
  const code = handlers.map(({ name, channel }) => `export { invoke as ${name} } from ${JSON.stringify(PROXY + encodeChannel(channel))};`).join('\n')
  // Never map proxies to the original main implementation or include its source.
  const output = new MagicString(code)
  return { code, map: output.generateMap({ source: file + '?ipc-proxy', includeContent: true, hires: true }) }
}

export function injectEntry(code: string, id: string, importId: string) {
  const output = new MagicString(code)
  const shebang = code.match(/^(?:\uFEFF)?#![^\n]*(?:\n|$)/)?.[0]
  const prefix = shebang && !shebang.endsWith('\n') ? '\n' : ''
  output.appendLeft(shebang?.length ?? 0, `${prefix}import ${JSON.stringify(importId)};\n`)
  return { code: output.toString(), map: output.generateMap({ source: id, includeContent: true, hires: true }) }
}

