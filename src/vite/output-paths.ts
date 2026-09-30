import path from 'node:path'
import MagicString from 'magic-string'
import type { ResolvedConfig, Rolldown } from 'vite'

/** Resolve generated file references relative to the chunk that contains them. */
export function renderOutputPaths(
  config: Pick<ResolvedConfig, 'root' | 'build'>,
  code: string,
  chunk: Rolldown.RenderedChunk,
  options: Rolldown.NormalizedOutputOptions,
  paths: ReadonlyMap<string, string>,
) {
  const output = new MagicString(code)
  let helper = '__electron_start_fileURLToPath'
  while (code.includes(helper)) helper += '_'
  let used = false
  for (const [marker, file] of paths) {
    if (!code.includes(marker)) continue
    if (options.format !== 'es' && options.format !== 'cjs')
      throw new Error('Electron main requires ES or CommonJS output')
    const directory = options.file
      ? path.dirname(path.resolve(config.root, options.file))
      : path.resolve(
          config.root,
          options.dir ?? config.build.outDir,
          path.dirname(chunk.fileName),
        )
    const relative = path.relative(directory, file).split(path.sep).join('/')
    const expression =
      options.format === 'cjs'
        ? `require('node:path').resolve(__dirname, ${JSON.stringify(relative)})`
        : `${helper}(new URL(${JSON.stringify(relative.split('/').map(encodeURIComponent).join('/'))}, import.meta.url))`
    output.replaceAll(marker, expression)
    used = true
  }
  if (!used) return
  if (options.format === 'es') {
    const shebang = code.match(/^(?:\uFEFF)?#![^\n]*(?:\n|$)/)?.[0]
    output.appendLeft(
      shebang?.length ?? 0,
      `import { fileURLToPath as ${helper} } from 'node:url';\n`,
    )
  }
  return {
    code: output.toString(),
    map: output.generateMap({ hires: true }),
  }
}
