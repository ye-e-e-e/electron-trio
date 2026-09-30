/** Declares a preload entry. electronStart compiles its main import to a file path. */
export function createPreload(_setup: () => void): string {
  throw new Error(
    'createPreload must be the default export of a preload entry compiled by electronStart',
  )
}
