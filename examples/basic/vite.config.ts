import react from '@vitejs/plugin-react'
import { electronTrio } from 'electron-trio/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    electronTrio({
      entry: 'electron/main.ts',
    }),
  ],
})
