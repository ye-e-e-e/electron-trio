import { BuildSession } from './internal/session.js'
import { rendererPlugin } from './internal/renderer-plugin.js'
import { hostPlugin } from './internal/host-plugin.js'
import type { IpcInvokeOptions, IpcInvokePlugins } from './internal/options.js'

export type { IpcInvokeOptions, IpcInvokePlugins }

export function ipcInvoke(options: IpcInvokeOptions = {}): IpcInvokePlugins {
  const session = new BuildSession(options)
  return {
    renderer: () => rendererPlugin(session),
    main: () => hostPlugin(session, 'main'),
    preload: () => hostPlugin(session, 'preload'),
  }
}
