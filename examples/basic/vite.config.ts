import react from '@vitejs/plugin-react'
import { electronStart } from 'electron-start/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    electronStart({
      entry: 'electron/main.ts',
    }),
  ],
})
