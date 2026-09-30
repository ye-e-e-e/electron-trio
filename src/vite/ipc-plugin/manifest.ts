import type { DefinitionRecord } from '#/compiler/types'

/** Immutable IPC definitions selected by the last successful renderer build. */
export class ProductionManifest {
  private definitions?: readonly DefinitionRecord[]

  publish(definitions: readonly DefinitionRecord[]) {
    const ordered = definitions
      .map((record) => Object.freeze({ ...record }))
      .sort((a, b) => a.channel.localeCompare(b.channel))
    this.definitions = Object.freeze(ordered)
  }

  read() {
    if (!this.definitions)
      throw new Error(
        'A successful renderer manifest is required before building main/preload',
      )
    return this.definitions
  }
}
