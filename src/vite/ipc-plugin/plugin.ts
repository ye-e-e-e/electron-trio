import type { Plugin } from 'vite'
import { ipcDispatcherPlugin } from '#/vite/ipc-dispatcher-plugin/plugin'
import { ipcEntryPlugin } from '#/vite/ipc-entry-plugin/plugin'
import { ipcMainPlugin } from '#/vite/ipc-main-plugin/plugin'
import { ipcManifestPlugin } from '#/vite/ipc-manifest-plugin/plugin'
import { ipcProtectionPlugin } from '#/vite/ipc-protection-plugin/plugin'
import { ipcProviderPlugin } from '#/vite/ipc-provider-plugin/plugin'
import { ipcRendererPlugin } from '#/vite/ipc-renderer-plugin/plugin'
import { IpcContext } from './context'
import type { IpcContextOptions } from './types'

/** IPC compilation and wiring; each plugin owns its environment and lifecycle. */
export function ipcPlugin(options: IpcContextOptions): Plugin[] {
  const context = new IpcContext(options)
  return [
    ipcDispatcherPlugin(),
    ipcRendererPlugin(context),
    ipcEntryPlugin(context),
    ipcMainPlugin(context),
    ipcProtectionPlugin(context),
    ipcProviderPlugin(context),
    ipcManifestPlugin(context),
  ]
}
