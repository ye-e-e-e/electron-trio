import path from 'node:path'
import { createBuilder } from 'vite'
import type { Plugin, ViteBuilder } from 'vite'
import { PRELOAD_ENVIRONMENT } from '#/vite/constants'
import { preloadEntryPlugin } from '#/vite/preload-entry-plugin/plugin'
import { preloadPathPlugin } from '#/vite/preload-path-plugin/plugin'
import { createPreloadEnvironment } from './environment'

export interface PreloadBuilderState {
  builder?: ViteBuilder
}

export function preloadPlugin(): Plugin[] {
  const state: PreloadBuilderState = {}
  return [
    {
      name: 'electron-trio:preload-builder',
      enforce: 'pre',
      config: {
        order: 'pre',
        handler(config) {
          const environments = (config.environments ??= {})
          // Assign the merged environment so Vite does not append user arrays a second time.
          environments[PRELOAD_ENVIRONMENT] = createPreloadEnvironment(
            { outDir: path.join(config.build?.outDir ?? 'dist', 'preload') },
            environments[PRELOAD_ENVIRONMENT],
          )
        },
      },
      buildApp: {
        order: 'pre',
        async handler(builder) {
          state.builder = builder
        },
      },
      async configureServer(server) {
        const builder = await createBuilder({
          root: server.config.root,
          configFile: server.config.configFile,
          mode: 'development',
          builder: { sharedConfigBuild: true },
        })
        if (!builder.environments[PRELOAD_ENVIRONMENT])
          throw new Error(
            'Preload builds require electronTrio in the local Vite config',
          )
        state.builder = builder
      },
    },
    preloadPathPlugin(state),
    preloadEntryPlugin(),
  ]
}
