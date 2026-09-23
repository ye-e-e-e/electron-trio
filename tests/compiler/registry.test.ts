import { expect, test } from 'vitest'
import { DefinitionRegistry } from '#/compiler/registry'

const source = (channel: string, name = 'run') => `import { createIpcInvoke } from 'electron-ipc-invoke'\nexport const ${name} = createIpcInvoke(${JSON.stringify(channel)}).handler(() => 1)`

test('registration only analyzes explicitly provided modules and caches identical source', async () => {
  const registry = new DefinitionRegistry()
  const analysis = await registry.analyze(source('one'), '/one.js')
  expect(await registry.analyze(source('one'), '/one.js')).toBe(analysis)
  expect(registry.definitions()).toEqual([])
  expect(await registry.register(source('one'), '/one.js', 'renderer')).toBe(analysis)
  expect(registry.read('/never-read.ts')).toBeUndefined()
  expect(registry.definitions()).toEqual([{ moduleKey: '/one.js', exportName: 'run', channel: 'one', line: 2 }])
})

test('caller sources merge and a main-only function is not exposed to renderer lookup', async () => {
  const registry = new DefinitionRegistry()
  await registry.register(source('one'), '/one.ts', 'main')
  expect(registry.lookup({ caller: 'main', moduleKey: '/one.ts', exportName: 'run' }).channel).toBe('one')
  expect(() => registry.lookup({ caller: 'renderer', moduleKey: '/one.ts', exportName: 'run' })).toThrow('Unknown IPC export')
  await registry.register(source('one'), '/one.ts', 'renderer')
  expect(registry.definitions()).toHaveLength(1)
  expect([...registry.callers('/one.ts')].sort()).toEqual(['main', 'renderer'])
  registry.remove('/one.ts', 'renderer')
  expect(registry.definitions('main')).toHaveLength(1)
  expect(registry.definitions('renderer')).toEqual([])
  registry.remove('/one.ts')
  expect(registry.definitions()).toEqual([])
})

test('replacement removes renamed exports and channels while main lookup uses the export name', async () => {
  const registry = new DefinitionRegistry()
  await registry.register(source('one'), '/one.ts', 'main')
  const revision = registry.revision
  await registry.register(source('two'), '/one.ts', 'main')
  expect(registry.lookup({ caller: 'main', moduleKey: '/one.ts', exportName: 'run' }).channel).toBe('two')
  await registry.register(source('three', 'next'), '/one.ts', 'main')
  expect(() => registry.lookup({ caller: 'main', moduleKey: '/one.ts', exportName: 'run' })).toThrow('Unknown IPC export')
  expect(registry.revision).toBeGreaterThan(revision)
})

test('duplicates report both locations without publishing half a module', async () => {
  const registry = new DefinitionRegistry()
  await registry.register(source('shared'), '/first.ts', 'renderer')
  await expect(registry.register(source('shared'), '/second.ts', 'main')).rejects.toThrow(/\/first.ts:2 and \/second.ts:2/)
  expect(registry.definitions()).toHaveLength(1)
  expect(registry.read('/second.ts')).toBeUndefined()
})

test('content updates preserve active callers without restoring removed callers', async () => {
  const registry = new DefinitionRegistry()
  await registry.register(source('one'), '/one.ts', 'main')
  await registry.register(source('one'), '/one.ts', 'renderer')
  const revision = registry.revision
  registry.update('/one.ts', await registry.analyze(source('two', 'next'), '/one.ts'))
  expect(registry.revision).toBe(revision + 1)
  expect(registry.lookup({ caller: 'main', moduleKey: '/one.ts', exportName: 'next' }).channel).toBe('two')
  expect(registry.lookup({ caller: 'renderer', moduleKey: '/one.ts', exportName: 'next' }).exportName).toBe('next')
  expect(() => registry.lookup({ caller: 'renderer', moduleKey: '/one.ts', exportName: 'run' })).toThrow('Unknown IPC export')
  registry.remove('/one.ts', 'renderer')
  registry.update('/one.ts', await registry.analyze(source('three', 'next'), '/one.ts'))
  expect(registry.lookup({ caller: 'main', moduleKey: '/one.ts', exportName: 'next' }).channel).toBe('three')
  expect(() => registry.lookup({ caller: 'renderer', moduleKey: '/one.ts', exportName: 'next' })).toThrow('Unknown IPC export')
})

test('failed versions cannot fall back to old metadata and repairs recover', async () => {
  const registry = new DefinitionRegistry()
  await registry.register(source('one'), '/one.ts', 'renderer')
  await expect(registry.register('export const broken = ;', '/one.ts', 'renderer')).rejects.toThrow()
  expect(registry.read('/one.ts')).toBeUndefined()
  expect(registry.definitions()).toEqual([])
  expect(() => registry.lookup({ caller: 'renderer', moduleKey: '/one.ts', exportName: 'run' })).toThrow('/one.ts')
  await registry.register(source('one'), '/one.ts', 'renderer')
  expect(registry.lookup({ caller: 'renderer', moduleKey: '/one.ts', exportName: 'run' }).moduleKey).toBe('/one.ts')
})

test('watch replacement defers duplicate checks until the current module graph is known', async () => {
  const registry = new DefinitionRegistry()
  await registry.register(source('same'), '/old.ts', 'renderer', { deferConflicts: true })
  registry.setActive('renderer', ['/old.ts'])
  await registry.register(source('same'), '/new.ts', 'renderer', { deferConflicts: true })
  registry.setActive('renderer', ['/new.ts'])
  expect(registry.lookup({ caller: 'renderer', moduleKey: '/new.ts', exportName: 'run' }).moduleKey).toBe('/new.ts')
  // No transform is required to restore a cached module in a later graph.
  registry.setActive('renderer', ['/old.ts'])
  expect(registry.lookup({ caller: 'renderer', moduleKey: '/old.ts', exportName: 'run' }).moduleKey).toBe('/old.ts')
  expect(() => registry.setActive('renderer', ['/old.ts', '/new.ts'])).toThrow('Duplicate IPC channel')
})

test('ordinary replacement withdraws definitions and independent modules survive failure', async () => {
  const registry = new DefinitionRegistry()
  await registry.register(source('one'), '/one.ts', 'renderer')
  await registry.register(source('two'), '/two.ts', 'renderer')
  await registry.register('export const normal = 1', '/one.ts', 'renderer')
  expect(registry.definitions().map(record => record.channel)).toEqual(['two'])
  await expect(registry.register('export const nope = ;', '/one.ts', 'renderer')).rejects.toThrow()
  expect(registry.lookup({ caller: 'renderer', moduleKey: '/two.ts', exportName: 'run' }).moduleKey).toBe('/two.ts')
})

test('target validation follows conflicts, caller removal, deletion and cached reactivation', async () => {
  const registry = new DefinitionRegistry()
  const main = () => registry.lookup({ caller: 'main', moduleKey: '/one.ts', exportName: 'run' })
  const renderer = (channel = 'one') => registry.lookup({ caller: 'renderer', moduleKey: `/${channel}.ts`, exportName: 'run' })
  await registry.register(source('one'), '/one.ts', 'main')
  await registry.register(source('one'), '/one.ts', 'renderer')
  await registry.register(source('two'), '/two.ts', 'renderer')
  expect(main()).toEqual(renderer())
  await expect(registry.register(source('two'), '/one.ts', 'main')).rejects.toThrow('Duplicate IPC channel')
  expect(main).toThrow('Duplicate IPC channel')
  expect(renderer).toThrow('Duplicate IPC channel')
  expect(renderer('two').moduleKey).toBe('/two.ts')
  await registry.register(source('one'), '/one.ts', 'main')
  expect(main()).toEqual(renderer())
  registry.remove('/one.ts', 'renderer')
  expect(renderer).toThrow('Unknown IPC export')
  expect(main().channel).toBe('one')
  registry.setActive('renderer', ['/one.ts'])
  expect(renderer()).toEqual(main())
  expect(() => renderer('two')).toThrow('Unknown IPC export')
  registry.remove('/one.ts')
  expect(main).toThrow('Unknown IPC export')
  expect(renderer).toThrow('Unknown IPC export')
  registry.setActive('main', ['/one.ts'])
  expect(main().channel).toBe('one')
  expect(renderer).toThrow('Unknown IPC export')
})
