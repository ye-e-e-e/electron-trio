import type { ElectronOptions } from './electron-plugin/types'
import type { IpcContextOptions } from './ipc-plugin/types'

export interface ElectronStartViteOptions extends IpcContextOptions {
  entry: string
  electron?: ElectronOptions
}
