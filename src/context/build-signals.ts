import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Target } from './types'

/** Only successful manifests schedule host builds. Vite owns source watching. */
export class BuildSignals {
  private state?: { directory: string; renderer: string; manifest: string; users: Set<object>; revision: number }

  open(): () => void {
    if (!this.state) {
      const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'electron-ipc-invoke-')))
      this.state = { directory, renderer: path.join(directory, 'renderer'), manifest: path.join(directory, 'manifest'), users: new Set(), revision: 0 }
      fs.writeFileSync(this.state.renderer, '0')
      fs.writeFileSync(this.state.manifest, '0')
    }
    const state = this.state
    const token = {}
    state.users.add(token)
    return () => {
      if (!state.users.delete(token) || state.users.size) return
      this.state = undefined
      fs.rmSync(state.directory, { recursive: true, force: true })
    }
  }

  files(target: Target) { return this.state ? [this.state[target === 'renderer' ? 'renderer' : 'manifest']] : [] }
  isSignal(file: string) { return file === this.state?.renderer || file === this.state?.manifest }
  notify(signal: 'renderer' | 'manifest') {
    if (this.state) fs.writeFileSync(this.state[signal], String(++this.state.revision))
  }
}
