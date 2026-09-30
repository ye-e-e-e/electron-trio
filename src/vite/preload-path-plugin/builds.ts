import { createHash } from 'node:crypto'
import path from 'node:path'
import { BuildEnvironment } from 'vite'
import type { Plugin, Rolldown, ViteBuilder } from 'vite'
import { PRELOAD_ENVIRONMENT } from '#/vite/constants'

/** Own each entry's build environment, outputs, and watch lifecycle. */
export class PreloadBuilds {
  private readonly entries = new Map<string, Promise<string>>()
  private readonly watchers = new Set<Rolldown.RolldownWatcher>()
  private readonly outputs = new Map<string, string>()
  private closed = false

  constructor(
    private readonly root: string,
    private readonly getBuilder: () => ViteBuilder,
    private readonly dev: boolean,
    private readonly reload: () => void,
  ) {}

  ensure(file: string): Promise<string> {
    if (this.closed)
      return Promise.reject(new Error('Preload builds are closed'))
    let pending = this.entries.get(file)
    if (!pending) {
      pending = this.build(file).catch((error) => {
        this.entries.delete(file)
        throw error
      })
      this.entries.set(file, pending)
    }
    return pending
  }

  async close() {
    this.closed = true
    await Promise.allSettled(this.entries.values())
    await Promise.all([...this.watchers].map((watcher) => watcher.close()))
    this.watchers.clear()
  }

  private async build(file: string) {
    const name = `preload-${createHash('sha256').update(path.relative(this.root, file).split(path.sep).join('/')).digest('hex').slice(0, 12)}`
    let outputFile: string | undefined
    let initialFile: string | undefined
    const outputs = this.outputs
    const capture: Plugin = {
      name: 'electron-start:preload-output',
      applyToEnvironment: (environment) =>
        environment.name === PRELOAD_ENVIRONMENT,
      generateBundle(options, bundle) {
        const entries = Object.values(bundle).filter(
          (item) => item.type === 'chunk',
        )
        if (
          options.format !== 'cjs' ||
          entries.length !== 1 ||
          !entries[0].isEntry
        )
          this.error('A preload requires one CommonJS output')
        const target = options.file
          ? path.resolve(this.environment.config.root, options.file)
          : path.resolve(
              this.environment.config.root,
              options.dir ?? this.environment.config.build.outDir,
              entries[0].fileName,
            )
        if (initialFile && target !== initialFile)
          this.error('Preload watch builds require a stable output filename')
        const owner = outputs.get(target)
        if (owner && owner !== file)
          this.error(
            `Preload output collision: ${owner} and ${file} both write ${target}`,
          )
        outputs.set(target, file)
        outputFile = target
      },
    }
    const builder = this.getBuilder()
    const environment = new BuildEnvironment(
      PRELOAD_ENVIRONMENT,
      builder.config,
      { options: { build: { lib: false, emptyOutDir: false } } },
    )
    const build = environment.config.build
    build.watch = this.dev ? build.watch || {} : null
    // Replace input rather than merging it with application-configured entries.
    build.rolldownOptions = {
      ...build.rolldownOptions,
      input: { [name]: file },
    }
    environment.config.plugins = [...environment.plugins, capture]
    await environment.init()
    const output = build.rolldownOptions.output
    if (Array.isArray(output) && output.length !== 1)
      throw new Error('A preload requires one CommonJS output')
    const result = await builder.build(environment)
    if (!Array.isArray(result) && 'on' in result) {
      this.watchers.add(result)
      let built = false
      try {
        await new Promise<void>((resolve, reject) =>
          result.on('event', (event) => {
            if (event.code === 'ERROR' && !built) reject(event.error)
            // A completed watch cycle without a successful bundle must not leave main waiting.
            if (event.code === 'END' && !built)
              reject(new Error(`No preload output was produced for ${file}`))
            if (event.code !== 'BUNDLE_END') return
            if (built) this.reload()
            else {
              built = true
              initialFile = outputFile
              resolve()
            }
          }),
        )
      } catch (error) {
        this.watchers.delete(result)
        await result.close()
        throw error
      }
    }
    if (!outputFile)
      throw new Error(`No preload output was produced for ${file}`)
    return outputFile
  }
}
