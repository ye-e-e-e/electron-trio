import path from 'node:path'
import type { Plugin } from 'vite'
import { MAIN_ENVIRONMENT } from '#/vite/constants'
import { renderOutputPaths } from '#/vite/output-paths'

const RENDERER_FILE_MARKER = '__ELECTRON_TRIO_RENDERER_FILE__'

/** Replace loadWindow's file placeholder relative to its containing main chunk. */
export function loadWindowPlugin(): Plugin {
  let rendererFile: string
  return {
    name: 'electron-trio:load-window',
    apply: 'build',
    enforce: 'post',
    applyToEnvironment: (environment) => environment.name === MAIN_ENVIRONMENT,
    configResolved(config) {
      rendererFile = path.resolve(
        config.root,
        config.environments.client.build.outDir,
        'index.html',
      )
    },
    renderChunk(code, chunk, options) {
      return renderOutputPaths(
        this.environment.config,
        code,
        chunk,
        options,
        new Map([[RENDERER_FILE_MARKER, rendererFile]]),
      )
    },
  }
}
