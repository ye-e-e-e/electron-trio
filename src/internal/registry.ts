import fs from 'node:fs'
import path from 'node:path'
import picomatch from 'picomatch'
import { globSync } from 'tinyglobby'
import { normalizePath } from 'vite'
import { parseHandlers } from './compiler.js'
import type { HandlerMeta } from './compiler.js'
import type { IpcInvokeOptions } from './options.js'

const DEFAULT_INCLUDE = ['**/*.ipc.ts']
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/dist-electron/**']
interface Source {
  readonly code: string
  readonly handlers: readonly HandlerMeta[]
}
export interface Snapshot {
  readonly files: ReadonlyMap<string, Source>
  readonly channels: ReadonlyMap<string, HandlerMeta>
}

/** Filesystem discovery and parsing; build scheduling belongs to the plugins. */
export class DefinitionRegistry {
  private root?: string
  private readonly include: string[]
  private readonly exclude: string[]
  private readonly included: (file: string) => boolean
  private readonly excluded: (file: string) => boolean
  private readonly sources = new Map<string, Source>()
  private snapshot?: Snapshot

  constructor(options: IpcInvokeOptions) {
    this.include = options.include ?? DEFAULT_INCLUDE
    this.exclude = [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])]
    for (const pattern of [...this.include, ...(options.exclude ?? [])]) {
      if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..') || pattern.startsWith('!')) {
        throw new Error('IPC patterns must be relative to root; use exclude for exclusions')
      }
    }
    this.included = picomatch(this.include)
    this.excluded = picomatch(this.exclude, { dot: true })
  }

  configure(root: string) {
    const resolved = path.resolve(root)
    if (this.root && this.root !== resolved) throw new Error('IPC builds must share one definition root; set the root option explicitly')
    this.root = resolved
  }

  matches(file: string): boolean {
    if (!this.root) return false
    const relative = normalizePath(path.relative(this.root, file))
    return !relative.startsWith('../') && this.included(relative) && !this.excluded(relative)
  }

  ignored = (file: string) => this.excluded(normalizePath(path.relative(this.root!, file)))

  invalidate() { this.snapshot = undefined }
  read(): Snapshot { return this.snapshot ?? this.refresh() }

  refresh(): Snapshot {
    if (!this.root) throw new Error('IPC definition root is not configured')
    this.snapshot = undefined
    const files = new Map<string, Source>()
    const channels = new Map<string, HandlerMeta>()
    const paths = globSync(this.include, { cwd: this.root, absolute: true, ignore: this.exclude }).map(normalizePath).sort()
    for (const file of paths) {
      if (!file.endsWith('.ts') || file.endsWith('.d.ts')) throw new Error(`IPC definitions must be TypeScript source modules: ${file}`)
      const code = fs.readFileSync(file, 'utf8')
      const cached = this.sources.get(file)
      const source = cached?.code === code ? cached : { code, handlers: parseHandlers(code, file) }
      this.sources.set(file, source)
      files.set(file, source)
      for (const handler of source.handlers) {
        const previous = channels.get(handler.channel)
        if (previous) throw new Error(`Duplicate IPC channel ${JSON.stringify(handler.channel)}: ${previous.file}:${previous.line} and ${handler.file}:${handler.line}`)
        channels.set(handler.channel, handler)
      }
    }
    for (const file of this.sources.keys()) if (!files.has(file)) this.sources.delete(file)
    return this.snapshot = { files, channels }
  }

  rendererHandlers(code: string, file: string, snapshot: Snapshot) {
    const source = snapshot.files.get(file)
    if (!source) throw new Error(`IPC definition changed during build: ${file}`)
    if (source.code === code) return source.handlers
    const parsed = parseHandlers(code, file)
    if (parsed.length !== source.handlers.length || parsed.some((handler, i) =>
      handler.name !== source.handlers[i].name || handler.channel !== source.handlers[i].channel)) {
      throw new Error(`A preceding plugin changed IPC exports: ${file}. Place the renderer plugin before that plugin.`)
    }
    return parsed
  }

  watchRoots(): string[] {
    if (!this.root) throw new Error('IPC definition root is not configured')
    const roots = new Set(this.include.map((pattern) => {
      const { base, isGlob } = picomatch.scan(pattern)
      let directory = path.resolve(this.root!, isGlob ? base : path.dirname(base))
      while (!fs.existsSync(directory)) directory = path.dirname(directory)
      return directory
    }))
    return [...roots].filter((root) => ![...roots].some((other) => other !== root && root.startsWith(other + path.sep)))
  }
}
