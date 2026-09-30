import { builtinModules } from 'node:module'
import { DevEnvironment, mergeConfig } from 'vite'
import type { EnvironmentOptions, ResolvedConfig } from 'vite'
import { createElectronHotChannel } from './hot-channel'
import { ElectronProcess } from './process'
import type { ElectronOptions } from './types'

export function createElectronEnvironment(
  options: { entry: string; outDir: string; electron?: ElectronOptions },
  userConfig: EnvironmentOptions = {},
): EnvironmentOptions {
  return mergeConfig(
    {
      resolve: {
        builtins: [...builtinModules, /^node:/, 'electron'],
        noExternal: ['electron-start'],
      },
      build: {
        outDir: options.outDir,
        emptyOutDir: false,
        copyPublicDir: false,
        lib: false,
        target: 'node22',
        minify: false,
        rolldownOptions: {
          input: options.entry,
          platform: 'node',
          output: {
            format: 'es',
            entryFileNames: 'main.mjs',
            codeSplitting: false,
          },
        },
      },
      dev: {
        moduleRunnerTransform: true,
        createEnvironment: (name, resolved) =>
          new ElectronDevEnvironment(name, resolved, options.electron ?? {}),
      },
    } satisfies EnvironmentOptions,
    userConfig,
  )
}

/** Vite module graph + remote Electron host. IPC definitions belong to the provider plugin. */
export class ElectronDevEnvironment extends DevEnvironment {
  readonly electron: ElectronProcess

  constructor(name: string, config: ResolvedConfig, options: ElectronOptions) {
    let electron: ElectronProcess
    const transport = createElectronHotChannel(() => electron.restart())
    super(name, config, { hot: true, transport })
    this.electron = electron = new ElectronProcess(
      options,
      config.logger,
      transport.api.connect,
    )
  }

  override async close() {
    await this.electron.close()
    await super.close()
  }
}
