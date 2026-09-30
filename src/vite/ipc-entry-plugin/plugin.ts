import { exactRegex } from '@rolldown/pluginutils'
import { perEnvironmentState } from 'vite'
import type { Plugin } from 'vite'
import {
  MAIN_ENVIRONMENT,
  PRELOAD_ENVIRONMENT,
  SOURCE_MODULE_FILTER,
} from '#/vite/constants'
import type { IpcContext } from '#/vite/ipc-plugin/context'
import { ENTRY_MODULE_PREFIX, RESOLVED_ENTRY_MODULE_PREFIX } from './constants'
import { HostEntry } from './host-entry'
import { devMainModule, mainModule } from './main-module'
import { devPreloadModule, preloadModule } from './preload-module'

/** Validate the entry and inject IPC initialization, with state local to each environment. */
export function ipcEntryPlugin(context: IpcContext): Plugin {
  return {
    name: 'electron-start:ipc-entry',
    enforce: 'pre',
    applyToEnvironment(environment) {
      const target =
        environment.name === MAIN_ENVIRONMENT
          ? 'main'
          : environment.name === PRELOAD_ENVIRONMENT
            ? 'preload'
            : undefined
      if (!target) return false
      const dev =
        target === 'preload'
          ? environment.config.mode === 'development'
          : environment.config.command === 'serve'
      const getEntry = perEnvironmentState(() => new HostEntry(target))
      return {
        name: `electron-start:ipc-${target}-entry`,
        perEnvironmentStartEndDuringDev: true,
        async buildStart(input) {
          await getEntry(this).prepare(this, input)
          if (!dev) context.manifest.read()
        },
        resolveId: {
          order: 'pre',
          filter: { id: exactRegex(ENTRY_MODULE_PREFIX + target) },
          handler(id) {
            return { id: '\0' + id, moduleSideEffects: 'no-treeshake' }
          },
        },
        load: {
          filter: { id: exactRegex(RESOLVED_ENTRY_MODULE_PREFIX + target) },
          handler() {
            if (dev)
              return target === 'main'
                ? devMainModule()
                : devPreloadModule(context.bridgeName)
            return target === 'main'
              ? mainModule(context.manifest.read())
              : preloadModule(context.manifest.read(), context.bridgeName)
          },
        },
        transform: {
          filter: { id: SOURCE_MODULE_FILTER },
          async handler(code, id) {
            const entry = getEntry(this)
            if (!entry.has(id)) return
            if (target === 'main') {
              if (
                (await context.registry.analyze(code, id)).kind === 'definition'
              ) {
                this.error(
                  'An IPC definition cannot also be a main/preload entry',
                )
              }
            }
            return entry.inject(code, id)
          },
        },
      }
    },
  }
}
