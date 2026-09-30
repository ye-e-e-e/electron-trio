import MagicString from 'magic-string'
import type { Plugin } from 'vite'
import { analyzePreloadEntry } from '#/compiler/preload-analyzer'
import { PRELOAD_ENVIRONMENT, SOURCE_MODULE_FILTER } from '#/vite/constants'
import { preloadModuleSideEffects } from './module-side-effects'

/** Validate preload entries and compile the createPreload macro. */
export function preloadEntryPlugin(): Plugin {
  return {
    name: 'electron-trio:preload-entry',
    enforce: 'pre',
    applyToEnvironment: (environment) =>
      environment.name === PRELOAD_ENVIRONMENT,
    options(input) {
      if (input.treeshake === false) return
      const treeshake =
        typeof input.treeshake === 'object' ? input.treeshake : {}
      return {
        ...input,
        treeshake: {
          ...treeshake,
          moduleSideEffects: preloadModuleSideEffects(
            treeshake.moduleSideEffects,
          ),
        },
      }
    },
    transform: {
      filter: { id: SOURCE_MODULE_FILTER },
      async handler(code, id) {
        const isEntry = this.getModuleInfo(id)?.isEntry
        const analysis = await analyzePreloadEntry(code, id)
        if (!analysis) {
          if (isEntry)
            this.error(
              `${id}: preload entries must use export default createPreload(() => { ... })`,
            )
          return
        }
        if (!isEntry)
          this.error(
            'Do not import another createPreload entry into preload; import shared helpers instead',
          )
        const { declaration, callback, importDeclaration, specifier } = analysis
        const output = new MagicString(code)
        output.overwrite(
          declaration.start,
          declaration.end,
          `(${code.slice(callback.start, callback.end)})();`,
        )
        if (importDeclaration && specifier) {
          if (importDeclaration.specifiers.length === 1)
            output.remove(importDeclaration.start, importDeclaration.end)
          else {
            const index = importDeclaration.specifiers.indexOf(specifier)
            if (index === 0)
              output.remove(
                specifier.start,
                importDeclaration.specifiers[1].start,
              )
            else
              output.remove(
                importDeclaration.specifiers[index - 1].end,
                specifier.end,
              )
          }
        }
        return {
          code: output.toString(),
          map: output.generateMap({
            source: id,
            includeContent: true,
            hires: true,
          }),
        }
      },
    },
  }
}
