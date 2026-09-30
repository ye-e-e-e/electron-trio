import type { DefinitionRecord } from '#/compiler/types'
import { DEV_CHANNEL } from './constants'

export function devPreloadModule(bridgeName: string) {
  return `import { contextBridge, ipcRenderer } from 'electron';\ncontextBridge.exposeInMainWorld(${JSON.stringify(bridgeName)}, { invoke: (moduleKey, exportName, input) => ipcRenderer.invoke(${JSON.stringify(DEV_CHANNEL)}, moduleKey, exportName, input) });`
}

export function preloadModule(
  definitions: readonly DefinitionRecord[],
  bridgeName: string,
): string {
  return [
    'import { contextBridge, ipcRenderer } from "electron";',
    `contextBridge.exposeInMainWorld(${JSON.stringify(bridgeName)}, {`,
    // Computed keys keep "__proto__" an ordinary own property.
    ...definitions.map(
      ({ channel }) =>
        `[${JSON.stringify(channel)}]: (input) => ipcRenderer.invoke(${JSON.stringify(channel)}, input),`,
    ),
    '});',
  ].join('\n')
}
