import type { Plugin } from 'vite'
import { PluginContext } from '#/context/context'
import type { IpcInvokeOptions, IpcInvokePlugins } from './types'
import { rendererProxyPlugin } from './renderer-proxy-plugin/plugin'
import { manifestPlugin } from './manifest-plugin/plugin'
import { mainProxyPlugin } from './main-proxy-plugin/plugin'
import { preloadCheckPlugin } from './preload-check-plugin/plugin'
import { ipcProviderPlugin } from './ipc-provider-plugin/plugin'
import { entryPlugin } from './entry-plugin/plugin'

export function ipcInvoke(options: IpcInvokeOptions = {}): IpcInvokePlugins {
  const context = new PluginContext(options)
  return [
    rendererPlugin(context),
    mainPlugin(context),
    preloadPlugin(context),
  ]
}

export function rendererPlugin(context: PluginContext): Plugin[] {
  return [
    {
      name: 'electron-ipc-invoke:config',
      enforce: 'pre',
      configResolved(config) { context.command = config.command },
    },
    rendererProxyPlugin(context),
    manifestPlugin(context),
    ipcProviderPlugin(context),
  ]
}

export function mainPlugin(context: PluginContext): Plugin[] {
  return [mainProxyPlugin(context), entryPlugin(context, 'main')]
}

export function preloadPlugin(context: PluginContext): Plugin[] {
  return [preloadCheckPlugin(context), entryPlugin(context, 'preload')]
}
