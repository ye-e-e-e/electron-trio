import { createHash } from 'node:crypto'
import MagicString from 'magic-string'
import { perEnvironmentState } from 'vite'
import type { Plugin } from 'vite'
import { analyzePreloadEntry } from '#/compiler/preload-analyzer'
import { MAIN_ENVIRONMENT, SOURCE_MODULE_FILTER } from '#/vite/constants'
import type { ElectronDevEnvironment } from '#/vite/electron-plugin/environment'
import { renderOutputPaths } from '#/vite/output-paths'
import type { PreloadBuilderState } from '#/vite/preload-plugin/plugin'
import { PreloadBuilds } from './builds'

const PRELOAD_PATH_MARKER = '__electron_start_preload_path_'

/** Discover preload imports in main, build them separately, and expose their paths. */
export function preloadPathPlugin(state: PreloadBuilderState): Plugin {
  const getState = perEnvironmentState((environment) => {
    const dev = environment.config.command === 'serve'
    return {
      dev,
      mainEntries: new Set<string>(),
      preloadEntries: new Set<string>(),
      paths: new Map<string, string>(),
      builds: new PreloadBuilds(
        environment.config.root,
        () => {
          const { builder } = state
          if (!builder)
            throw new Error(
              dev
                ? 'The preload builder is not initialized'
                : 'Production preload builds require builder.buildApp()',
            )
          return builder
        },
        dev,
        () => {
          if (dev)
            (environment as ElectronDevEnvironment).electron.reloadWindows()
        },
      ),
    }
  })
  return {
    name: 'electron-start:preload-path',
    enforce: 'pre',
    applyToEnvironment: (environment) => environment.name === MAIN_ENVIRONMENT,
    perEnvironmentStartEndDuringDev: true,
    async buildStart(options) {
      const { mainEntries } = getState(this)
      mainEntries.clear()
      const input = options.input
      const entries =
        typeof input === 'string'
          ? [input]
          : Array.isArray(input)
            ? input
            : Object.values(input ?? {})
      for (const entry of entries) {
        const resolved = await this.resolve(entry, undefined, { isEntry: true })
        if (resolved && !resolved.external) mainEntries.add(resolved.id)
      }
    },
    transform: {
      filter: { id: SOURCE_MODULE_FILTER },
      async handler(code, id) {
        const { dev, mainEntries, preloadEntries, builds, paths } =
          getState(this)
        const analysis = await analyzePreloadEntry(code, id)
        if (!analysis) {
          if (preloadEntries.has(id))
            this.error(
              `${id}: preload entries must use export default createPreload(() => { ... })`,
            )
          return
        }
        if (mainEntries.has(id))
          this.error('A preload entry cannot also be the main entry')
        preloadEntries.add(id)
        const preloadPath = await builds.ensure(id)
        let generated: string
        if (dev) {
          // The path stays fixed; the preload watcher rebuilds and reloads windows.
          generated = `export default ${JSON.stringify(preloadPath)};\nif (import.meta.hot) import.meta.hot.accept();\n`
        } else {
          const marker =
            PRELOAD_PATH_MARKER +
            createHash('sha256').update(id).digest('hex') +
            '__'
          paths.set(marker, preloadPath)
          generated = `export default ${marker};`
        }
        const output = new MagicString(generated)
        return {
          code: output.toString(),
          map: output.generateMap({
            source: id + '?preload-path',
            includeContent: true,
            hires: true,
          }),
          moduleSideEffects: false,
        }
      },
    },
    renderChunk(code, chunk, options) {
      const { paths } = getState(this)
      return renderOutputPaths(
        this.environment.config,
        code,
        chunk,
        options,
        paths,
      )
    },
    async closeBundle() {
      await getState(this).builds.close()
    },
  }
}
