import type { Rolldown } from 'vite'

type ModuleSideEffects = Rolldown.TreeshakingOptions['moduleSideEffects']

/** Remove unused compile-time API imports while preserving dependency side effects. */
export function preloadModuleSideEffects(
  sideEffects: ModuleSideEffects,
): ModuleSideEffects {
  if (typeof sideEffects === 'function')
    return (id, external) =>
      id === 'electron-start' ? false : sideEffects(id, external)

  const apiRule = { test: /^electron-start$/, sideEffects: false }
  if (Array.isArray(sideEffects))
    return sideEffects.every((rule) => typeof rule === 'string')
      ? sideEffects.filter((id) => id !== 'electron-start')
      : [apiRule, ...sideEffects]

  if (sideEffects === false) return false
  if (sideEffects === 'no-external')
    return [
      apiRule,
      { external: true, sideEffects: false },
      { external: false, sideEffects: true },
    ]
  return sideEffects === true ? [apiRule, { sideEffects: true }] : [apiRule]
}
