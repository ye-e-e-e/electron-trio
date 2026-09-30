import { expect, test, vi } from 'vitest'
import { IpcRegistry } from '#/vite/ipc-plugin/ipc-registry'

const source = (channel: string, name = 'run') =>
  `import { createIpcInvoke } from 'electron-trio'\nexport const ${name} = createIpcInvoke(${JSON.stringify(channel)}).handler(() => 1)`

test('analysis does not register definitions before a caller encounters them', async () => {
  const registry = new IpcRegistry()
  await registry.analyze(source('one'), '/one.js')
  expect(registry.definitions()).toEqual([])
  expect(registry.isDiscovered('/one.js')).toBe(false)
  await registry.register(source('one'), '/one.js', 'renderer')
  expect(registry.isDiscovered('/one.js')).toBe(true)
  expect(registry.definitions()).toEqual([
    { moduleKey: '/one.js', exportName: 'run', channel: 'one', line: 2 },
  ])
})

test('discovery subscriptions replay IPC modules and notify once per newly registered module', async () => {
  const registry = new IpcRegistry()
  await registry.register('export const value = 1', '/ordinary.ts', 'main')
  await registry.register(source('first'), '/first.ts', 'main')
  registry.invalidate('/first.ts')
  const previous = vi.fn()
  const unsubscribe = registry.subscribeDiscovery(previous)
  expect(previous.mock.calls).toEqual([['/first.ts']])
  expect(registry.isDiscovered('/ordinary.ts')).toBe(false)
  await registry.register(source('first'), '/first.ts', 'renderer')
  expect(previous).toHaveBeenCalledTimes(1)

  unsubscribe()
  const current = vi.fn()
  registry.subscribeDiscovery(current)
  await registry.register(source('second'), '/second.ts', 'renderer')
  await expect(
    registry.register(source('second'), '/conflict.ts', 'main'),
  ).rejects.toThrow('Duplicate IPC channel')
  expect(registry.isDiscovered('/conflict.ts')).toBe(false)
  expect(previous).toHaveBeenCalledTimes(1)
  expect(current.mock.calls).toEqual([['/first.ts'], ['/second.ts']])
})

test('invalidation retains callers but only valid IPC content can restore their targets', async () => {
  const registry = new IpcRegistry()
  const target = {
    caller: 'main',
    moduleKey: '/one.ts',
    exportName: 'run',
  } as const
  await registry.register(source('one'), '/one.ts', 'main')
  await registry.register(source('one'), '/one.ts', 'renderer')

  registry.invalidate('/one.ts')
  expect(registry.isDiscovered('/one.ts')).toBe(true)
  expect([...registry.callers('/one.ts')].sort()).toEqual(['main', 'renderer'])
  expect(registry.read('/one.ts')).toBeUndefined()
  expect(registry.definitions()).toEqual([])
  expect(() => registry.lookup(target)).toThrow('Unknown IPC export')

  registry.update(
    '/one.ts',
    await registry.analyze('export const run = () => 2', '/one.ts'),
  )
  expect(registry.definitions()).toEqual([])
  expect(() => registry.lookup(target)).toThrow('Unknown IPC export')

  registry.update(
    '/one.ts',
    await registry.analyze(source('restored'), '/one.ts'),
  )
  expect(registry.lookup(target).channel).toBe('restored')
  expect(registry.lookup({ ...target, caller: 'renderer' }).channel).toBe(
    'restored',
  )
})

test('caller sources merge and a main-only function is not exposed to renderer lookup', async () => {
  const registry = new IpcRegistry()
  await registry.register(source('one'), '/one.ts', 'main')
  expect(
    registry.lookup({ caller: 'main', moduleKey: '/one.ts', exportName: 'run' })
      .channel,
  ).toBe('one')
  expect(() =>
    registry.lookup({
      caller: 'renderer',
      moduleKey: '/one.ts',
      exportName: 'run',
    }),
  ).toThrow('Unknown IPC export')
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
  const registry = new IpcRegistry()
  await registry.register(source('one'), '/one.ts', 'main')
  await registry.register(source('two'), '/one.ts', 'main')
  expect(
    registry.lookup({ caller: 'main', moduleKey: '/one.ts', exportName: 'run' })
      .channel,
  ).toBe('two')
  await registry.register(source('three', 'next'), '/one.ts', 'main')
  expect(() =>
    registry.lookup({
      caller: 'main',
      moduleKey: '/one.ts',
      exportName: 'run',
    }),
  ).toThrow('Unknown IPC export')
})

test('duplicates report both locations without publishing half a module', async () => {
  const registry = new IpcRegistry()
  await registry.register(source('shared'), '/first.ts', 'renderer')
  await expect(
    registry.register(source('shared'), '/second.ts', 'main'),
  ).rejects.toThrow(/\/first.ts:2 and \/second.ts:2/)
  expect(registry.definitions()).toHaveLength(1)
  expect(registry.read('/second.ts')).toBeUndefined()
})

test('content updates preserve active callers without restoring removed callers', async () => {
  const registry = new IpcRegistry()
  await registry.register(source('one'), '/one.ts', 'main')
  await registry.register(source('one'), '/one.ts', 'renderer')
  registry.update(
    '/one.ts',
    await registry.analyze(source('two', 'next'), '/one.ts'),
  )
  expect(
    registry.lookup({
      caller: 'main',
      moduleKey: '/one.ts',
      exportName: 'next',
    }).channel,
  ).toBe('two')
  expect(
    registry.lookup({
      caller: 'renderer',
      moduleKey: '/one.ts',
      exportName: 'next',
    }).exportName,
  ).toBe('next')
  expect(() =>
    registry.lookup({
      caller: 'renderer',
      moduleKey: '/one.ts',
      exportName: 'run',
    }),
  ).toThrow('Unknown IPC export')
  registry.remove('/one.ts', 'renderer')
  registry.invalidate('/one.ts')
  registry.update(
    '/one.ts',
    await registry.analyze(source('three', 'next'), '/one.ts'),
  )
  expect(
    registry.lookup({
      caller: 'main',
      moduleKey: '/one.ts',
      exportName: 'next',
    }).channel,
  ).toBe('three')
  expect(() =>
    registry.lookup({
      caller: 'renderer',
      moduleKey: '/one.ts',
      exportName: 'next',
    }),
  ).toThrow('Unknown IPC export')
})

test('failed versions cannot fall back to old metadata and repairs recover', async () => {
  const registry = new IpcRegistry()
  await registry.register(source('one'), '/one.ts', 'renderer')
  await expect(
    registry.register('export const broken = ;', '/one.ts', 'renderer'),
  ).rejects.toThrow()
  expect(registry.read('/one.ts')).toBeUndefined()
  expect(registry.definitions()).toEqual([])
  expect(() =>
    registry.lookup({
      caller: 'renderer',
      moduleKey: '/one.ts',
      exportName: 'run',
    }),
  ).toThrow('/one.ts')
  await registry.register(source('one'), '/one.ts', 'renderer')
  expect(
    registry.lookup({
      caller: 'renderer',
      moduleKey: '/one.ts',
      exportName: 'run',
    }).moduleKey,
  ).toBe('/one.ts')
})

test('ordinary replacement withdraws definitions and independent modules survive failure', async () => {
  const registry = new IpcRegistry()
  await registry.register(source('one'), '/one.ts', 'renderer')
  await registry.register(source('two'), '/two.ts', 'renderer')
  await registry.register('export const normal = 1', '/one.ts', 'renderer')
  expect(registry.definitions().map((record) => record.channel)).toEqual([
    'two',
  ])
  await expect(
    registry.register('export const nope = ;', '/one.ts', 'renderer'),
  ).rejects.toThrow()
  expect(
    registry.lookup({
      caller: 'renderer',
      moduleKey: '/two.ts',
      exportName: 'run',
    }).moduleKey,
  ).toBe('/two.ts')
})

test('conflicting updates invalidate callers until the definition is repaired', async () => {
  const registry = new IpcRegistry()
  const main = () =>
    registry.lookup({ caller: 'main', moduleKey: '/one.ts', exportName: 'run' })
  const renderer = (channel = 'one') =>
    registry.lookup({
      caller: 'renderer',
      moduleKey: `/${channel}.ts`,
      exportName: 'run',
    })
  await registry.register(source('one'), '/one.ts', 'main')
  await registry.register(source('one'), '/one.ts', 'renderer')
  await registry.register(source('two'), '/two.ts', 'renderer')
  expect(main()).toEqual(renderer())
  await expect(
    registry.register(source('two'), '/one.ts', 'main'),
  ).rejects.toThrow('Duplicate IPC channel')
  expect(main).toThrow('Duplicate IPC channel')
  expect(renderer).toThrow('Duplicate IPC channel')
  expect(renderer('two').moduleKey).toBe('/two.ts')
  await registry.register(source('one'), '/one.ts', 'main')
  expect(main()).toEqual(renderer())
})
