import type { Plugin } from 'vite'
import type { PluginContextOptions } from '#/context/types'

export interface IpcInvokeOptions extends PluginContextOptions {}

export type IpcInvokePlugins = [renderer: Plugin[], main: Plugin[], preload: Plugin[]]
