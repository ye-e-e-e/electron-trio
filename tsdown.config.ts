import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    vite: 'src/vite.ts',
    bootstrap: 'src/runtime/bootstrap.ts',
  },
  exports: {
    exclude: ['bootstrap'],
  },
  format: 'esm',
  target: 'es2022',
  dts: true,
})
