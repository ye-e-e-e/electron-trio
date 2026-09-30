import type { BrowserWindow } from 'electron'

// Replaced by electronStart when bundling the main environment.
declare const __ELECTRON_START_RENDERER_FILE__: string

/** Loads the development server or the built renderer's index.html in a main-process window. */
export function loadWindow(window: BrowserWindow): Promise<void> {
  const url = process.env.VITE_DEV_SERVER_URL
  if (url) return window.loadURL(url)

  if (typeof __ELECTRON_START_RENDERER_FILE__ === 'undefined')
    throw new Error(
      'loadWindow must be bundled by electronStart for production',
    )
  return window.loadFile(__ELECTRON_START_RENDERER_FILE__)
}
