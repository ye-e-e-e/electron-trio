import { expect, test, vi } from 'vitest'
import { DefinitionSources } from '#/context/definition-sources'

test('source subscriptions replay existing modules and stop notifying after unsubscribe', () => {
  const sources = new DefinitionSources()
  sources.track('/first.ts', 'main')
  const previous = vi.fn()
  const unsubscribeSources = sources.subscribe(previous)
  expect(previous).toHaveBeenCalledWith('/first.ts')
  unsubscribeSources()
  const current = vi.fn()
  sources.subscribe(current)
  sources.track('/second.ts', 'renderer')
  expect(previous).toHaveBeenCalledTimes(1)
  expect(current.mock.calls).toEqual([['/first.ts'], ['/second.ts']])
})

test('removing a caller keeps file discovery without restoring its permission', () => {
  const sources = new DefinitionSources()
  sources.track('/shared.ts', 'main')
  sources.track('/shared.ts', 'renderer')
  sources.setActive('main', [])
  expect([...sources.keys()]).toEqual(['/shared.ts'])
  expect([...sources.callers('/shared.ts')]).toEqual(['renderer'])
  sources.setActive('renderer', [])
  expect(sources.has('/shared.ts')).toBe(true)
  expect(sources.callers('/shared.ts').size).toBe(0)
  sources.setActive('main', ['/shared.ts'])
  expect([...sources.callers('/shared.ts')]).toEqual(['main'])
})
