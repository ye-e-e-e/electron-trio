import type { PluginOption } from 'vite'
import { electronPlugin } from './electron-plugin/plugin'
import { ipcPlugin } from './ipc-plugin/plugin'
import { loadWindowPlugin } from './load-window-plugin/plugin'
import { preloadPlugin } from './preload-plugin/plugin'
import type { ElectronStartViteOptions } from './types'

export function electronStart(options: ElectronStartViteOptions): PluginOption {
  if (!options?.entry?.trim()) throw new Error('electronStart requires entry')
  return [
    electronPlugin(options),
    loadWindowPlugin(),
    preloadPlugin(),
    ipcPlugin(options),
  ]
}
