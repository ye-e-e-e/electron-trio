import MagicString from 'magic-string'
import type { HookHandler, Plugin } from 'vite'
import { ENTRY_MODULE_PREFIX } from './constants'

type BuildStart = HookHandler<NonNullable<Plugin['buildStart']>>

/** One application entry and its generated initialization module. */
export class HostEntry {
  private entry?: string
  private readonly generated: string

  constructor(private readonly target: 'main' | 'preload') {
    this.generated = ENTRY_MODULE_PREFIX + target
  }

  async prepare(
    context: ThisParameterType<BuildStart>,
    input: Parameters<BuildStart>[0],
  ) {
    this.entry = undefined
    const value = input.input
    const inputs =
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value
          : Object.values(value ?? {})
    if (inputs.length !== 1)
      context.error(`IPC ${this.target} requires one entry`)
    const resolved = await context.resolve(inputs[0], undefined, {
      isEntry: true,
    })
    if (!resolved || resolved.external)
      context.error(`Cannot resolve IPC ${this.target} entry: ${inputs[0]}`)
    this.entry = resolved.id
  }

  has(id: string) {
    return id === this.entry
  }

  inject(code: string, id: string) {
    const output = new MagicString(code)
    const shebang = code.match(/^(?:\uFEFF)?#![^\n]*(?:\n|$)/)?.[0]
    const prefix = shebang && !shebang.endsWith('\n') ? '\n' : ''
    output.appendLeft(
      shebang?.length ?? 0,
      `${prefix}import ${JSON.stringify(this.generated)};\n`,
    )
    return {
      code: output.toString(),
      map: output.generateMap({
        source: id,
        includeContent: true,
        hires: true,
      }),
    }
  }
}
