import type { Plugin } from 'vite'
import type { IpcContext } from '#/vite/ipc-plugin/context'
import { ipcDefinitionId } from '#/vite/ipc-plugin/module-id'
import { IpcManifestCollector } from './manifest-collector'

/** Publish the IPC definitions retained by successful renderer outputs. */
export function ipcManifestPlugin(context: IpcContext): Plugin {
  const collector = new IpcManifestCollector(
    (ids) => {
      context.registry.setActive('renderer', Array.from(ids, ipcDefinitionId))
      return context.registry.definitions('renderer')
    },
    (definitions) => context.manifest.publish(definitions),
  )
  return {
    name: 'electron-start:ipc-manifest',
    apply: 'build',
    enforce: 'pre',
    applyToEnvironment: (environment) => environment.name === 'client',
    options: {
      order: 'post',
      handler(input) {
        collector.configure(input)
      },
    },
  }
}
