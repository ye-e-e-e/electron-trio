import type { PluginOption } from 'vite'
import { electronPlugin } from './electron-plugin/plugin'
import { ipcPlugin } from './ipc-plugin/plugin'
import { loadWindowPlugin } from './load-window-plugin/plugin'
import { preloadPlugin } from './preload-plugin/plugin'
import type { ElectronTrioViteOptions } from './types'

export function electronTrio(options: ElectronTrioViteOptions): PluginOption {
  if (!options?.entry?.trim()) throw new Error('electronTrio requires entry')
  return [
    electronPlugin(options),
    loadWindowPlugin(),
    preloadPlugin(),
    ipcPlugin(options),
  ]
}
