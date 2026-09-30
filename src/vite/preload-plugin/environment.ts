import { mergeConfig } from 'vite'
import type { EnvironmentOptions } from 'vite'

export function createPreloadEnvironment(
  options: { outDir: string },
  userConfig: EnvironmentOptions = {},
): EnvironmentOptions {
  return mergeConfig(
    {
      resolve: {
        external: ['electron'],
        noExternal: true,
      },
      build: {
        outDir: options.outDir,
        copyPublicDir: false,
        lib: false,
        target: 'node22',
        minify: false,
        rolldownOptions: {
          platform: 'node',
          output: {
            format: 'cjs',
            entryFileNames: '[name].cjs',
            codeSplitting: false,
          },
        },
      },
    } satisfies EnvironmentOptions,
    userConfig,
  )
}
