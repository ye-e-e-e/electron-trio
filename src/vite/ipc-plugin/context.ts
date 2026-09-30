import { IpcRegistry } from './ipc-registry'
import { ProductionManifest } from './manifest'
import type { IpcContextOptions } from './types'

const DEFAULT_BRIDGE_NAME = '__ipc'

/** Shared by the renderer, main and preload environments of one application. */
export class IpcContext {
  readonly registry = new IpcRegistry()
  readonly manifest = new ProductionManifest()
  readonly bridgeName: string

  constructor(options: IpcContextOptions) {
    this.bridgeName = options.bridgeName ?? DEFAULT_BRIDGE_NAME
    if (!this.bridgeName.trim()) throw new Error('bridgeName must be non-empty')
  }
}
