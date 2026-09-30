import { expect, test } from 'vitest'
import type { DefinitionRecord } from '#/compiler/types'
import { ProductionManifest } from '#/vite/ipc-plugin/manifest'

const record = (
  moduleKey = '/one.ts',
  exportName = 'run',
): DefinitionRecord => ({ moduleKey, exportName, channel: 'same', line: 2 })

test('published manifests own immutable mappings', () => {
  const manifest = new ProductionManifest()
  expect(() => manifest.read()).toThrow('successful renderer manifest')
  const first = record()
  manifest.publish([first])
  const published = manifest.read()
  first.moduleKey = '/mutated.ts'
  expect(published[0].moduleKey).toBe('/one.ts')
  manifest.publish([record('/two.ts')])
  expect(manifest.read()[0].moduleKey).toBe('/two.ts')
  manifest.publish([record('/two.ts', 'renamed')])
  expect(manifest.read()[0].exportName).toBe('renamed')
  manifest.publish([])
  expect(manifest.read()).toEqual([])
})
