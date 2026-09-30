import type { BrowserWindow } from 'electron'
import { afterEach, expect, test, vi } from 'vitest'
import { loadWindow } from '#/index'

afterEach(() => {
  vi.unstubAllEnvs()
})

test('loads the development server URL', async () => {
  vi.stubEnv('VITE_DEV_SERVER_URL', 'http://localhost:5173/application/')
  const loadURL = vi.fn().mockResolvedValue(undefined)
  await loadWindow({ loadURL } as unknown as BrowserWindow)
  expect(loadURL).toHaveBeenCalledExactlyOnceWith(
    'http://localhost:5173/application/',
  )
})
