import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { watch } from 'chokidar'
import type { FSWatcher } from 'chokidar'
import { normalizePath } from 'vite'
import type { DefinitionRegistry, Snapshot } from './registry.js'
import type { Target } from './options.js'

type Signal = 'definitions' | 'renderer' | 'channels'
interface WatchState {
  directory: string
  files: Record<Signal, string>
  users: Set<() => void>
  ready: Promise<void>
  watcher?: FSWatcher
  error?: Error
  revision: number
  definitions?: string
}

/** Adapt shared changes to Rolldown's file-based watch API. */
export class BuildWatch {
  private state?: WatchState
  constructor(private readonly definitions: DefinitionRegistry) {}

  async open(watchDefinitions: boolean, invalidate = () => {}): Promise<() => Promise<void>> {
    const state = this.state ??= this.start(watchDefinitions)
    // Each acquisition owns one token even if its callback is shared.
    const token = () => invalidate()
    state.users.add(token)
    const close = async () => {
      if (!state.users.delete(token) || state.users.size) return
      if (this.state === state) this.state = undefined
      await state.watcher?.close()
      fs.rmSync(state.directory, { recursive: true, force: true })
    }
    try { await state.ready; return close }
    catch (error) { await close(); throw error }
  }

  files(target: Target): string[] {
    if (!this.state) return []
    const { files } = this.state
    return [files.definitions, target === 'renderer' ? files.renderer : files.channels]
  }

  isSignal(file: string): boolean {
    return !!this.state && Object.values(this.state.files).includes(normalizePath(file))
  }

  check() { if (this.state?.error) throw this.state.error }

  initialize(snapshot: Snapshot) {
    if (this.state && this.state.definitions === undefined) this.state.definitions = signature(snapshot)
  }

  definitionsChanged(): Snapshot {
    this.definitions.invalidate()
    try {
      const snapshot = this.definitions.refresh()
      this.updateDefinitions(signature(snapshot))
      return snapshot
    } catch (error) {
      this.updateDefinitions(`error:${String(error)}`)
      throw error
    }
  }

  private updateDefinitions(value: string) {
    const state = this.state
    if (!state || state.definitions === value) return
    state.definitions = value
    for (const invalidate of state.users) invalidate()
    this.notify('definitions')
  }

  notify(signal: Signal) {
    const state = this.state
    if (state) fs.writeFileSync(state.files[signal], String(++state.revision))
  }

  private start(watchDefinitions: boolean): WatchState {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'electron-ipc-invoke-')))
    const files = Object.fromEntries(['definitions', 'renderer', 'channels'].map((name) => [name, normalizePath(path.join(directory, name))])) as Record<Signal, string>
    for (const file of Object.values(files)) fs.writeFileSync(file, '0')
    const state: WatchState = { directory, files, users: new Set(), ready: Promise.resolve(), revision: 0 }
    const roots = watchDefinitions ? this.definitions.watchRoots() : []
    if (roots.length) {
      const watcher = state.watcher = watch(roots, { ignoreInitial: true, ignored: this.definitions.ignored })
      watcher.on('all', (event, file) => {
        if (this.state !== state || !['add', 'change', 'unlink'].includes(event) || !this.definitions.matches(file)) return
        // The file signal makes each build report parsing errors through Vite.
        try { this.definitionsChanged() } catch {}
      })
      watcher.on('error', (error) => {
        state.error = error instanceof Error ? error : new Error(String(error))
        if (this.state === state) this.notify('definitions')
      })
      state.ready = new Promise<void>((resolve, reject) => watcher.once('ready', resolve).once('error', reject))
    }
    return state
  }
}

function signature(snapshot: Snapshot): string {
  return JSON.stringify([...snapshot.files].map(([file, { handlers }]) => [file, handlers.map(({ name, channel }) => [name, channel])]))
}
