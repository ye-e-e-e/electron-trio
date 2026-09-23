import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig(({ mode }) => {
  const isolatedSuite = mode === 'electron' ? 'tests/electron/**/*.test.ts'
    : mode === 'package' ? 'tests/package/**/*.test.ts' : undefined
  return {
    test: {
      include: isolatedSuite ? [isolatedSuite] : ['tests/**/*.test.ts'],
      exclude: [...configDefaults.exclude, ...(isolatedSuite ? [] : ['tests/electron/**', 'tests/package/**'])],
      environment: 'node',
      pool: 'forks',
      restoreMocks: true,
      unstubGlobals: true,
      // Source imports inside generated fixture strings are outside Vitest's module graph.
      forceRerunTriggers: [...configDefaults.forceRerunTriggers, '**/src/**'],
    },
    server: {
      watch: { ignored: ['**/.ipc-test-*/**', '**/dist/**', '**/dist-electron/**'] },
    },
  }
})
