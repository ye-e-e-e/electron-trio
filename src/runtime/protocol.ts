import type { HotPayload } from 'vite'

export interface ElectronBootstrapConfig {
  root: string
  entry: string
  rendererUrl: string
}

/** Messages exchanged over the private Vite/Electron process IPC channel. */
export type ElectronProcessMessage =
  | { type: 'runner:connected' }
  | { type: 'runner:message'; payload: HotPayload }
  | { type: 'electron:reload' }
  | { type: 'electron:quit' }

export const VALIDATE_REQUEST = 'electron-trio:validate'
export const VALIDATE_RESPONSE = 'electron-trio:validated'
