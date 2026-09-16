import type { Plugin } from 'vite'

export interface IpcInvokeOptions {
  /** Definition patterns relative to root. Defaults to all .ipc.ts files under root, subject to exclude. Only TypeScript modules are supported. */
  include?: string[]
  exclude?: string[]
  /** Shared definition root; defaults to Vite's root. */
  root?: string
  bridgeName?: string
}

export type IpcInvokePlugins = [renderer: Plugin, main: Plugin, preload: Plugin]

export type Target = 'renderer' | 'main' | 'preload'
