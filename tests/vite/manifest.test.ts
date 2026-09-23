import { expect, test } from 'vitest'
import type { Rolldown } from 'vite'
import { ManifestCollector } from '#/vite/manifest-plugin/manifest-collector'
import { PluginContext } from '#/context/context'
import type { DefinitionRecord } from '#/compiler/types'

const record = (moduleKey = '/one.ts', exportName = 'run'): DefinitionRecord => ({ moduleKey, exportName, channel: 'same', line: 2 })
const code = (channel: string) => `import { createIpcInvoke } from 'electron-ipc-invoke'; export const run = createIpcInvoke('${channel}').handler(() => 1)`

test('published manifests own immutable mappings and track same-channel implementation moves', () => {
  const context = new PluginContext({})
  const first = record()
  context.publishManifest([first])
  const published = context.requireManifest()
  first.moduleKey = '/mutated.ts'
  expect(published[0].moduleKey).toBe('/one.ts')
  context.publishManifest([record('/two.ts')])
  expect(context.requireManifest()[0].moduleKey).toBe('/two.ts')
  context.publishManifest([record('/two.ts', 'renamed')])
  expect(context.requireManifest()[0].exportName).toBe('renamed')
})

test('renderer candidates exclude old graph modules without discarding reusable analysis', async () => {
  const context = new PluginContext({})
  await context.registry.register(code('same'), '/one.ts', 'renderer', { deferConflicts: true })
  context.publishManifest(context.collectRendererCandidates(['/one.ts']))
  await context.registry.register(code('same'), '/two.ts', 'renderer', { deferConflicts: true })
  expect(context.collectRendererCandidates(['/two.ts'])).toEqual([record('/two.ts')].map(item => ({ ...item, line: 1 })))
  // Failed or incomplete candidate work has not changed the last successful publication.
  expect(context.requireManifest()[0].moduleKey).toBe('/one.ts')
  expect(context.collectRendererCandidates(['/one.ts'])[0].moduleKey).toBe('/one.ts')
})

function invokeHook(plugin: Rolldown.Plugin, name: 'renderStart' | 'generateBundle', ...args: unknown[]) {
  const hook = plugin[name]!
  const fn = typeof hook === 'function' ? hook : hook.handler
  return Reflect.apply(fn, { getModuleIds: () => ['/one.ts'], error: (message: string) => { throw new Error(message) } }, args)
}
function outputBundle(moduleKey = '/one.ts'): Rolldown.OutputBundle {
  return { 'entry.js': { type: 'chunk', modules: {
    [moduleKey]: { renderedExports: ['run'] },
  } } } as unknown as Rolldown.OutputBundle
}

test('a new multi-output build cannot reuse another output from the previous build', () => {
  let candidate = record()
  const publications: DefinitionRecord[][] = []
  const collector = new ManifestCollector(() => [candidate], records => { publications.push([...records]) })
  function start() {
    const options = { output: [{}, {}] } as Rolldown.InputOptions & { output: Rolldown.OutputOptions[] }
    collector.configure(options)
    const input = {} as Rolldown.NormalizedInputOptions
    collector.begin(input)
    const plugins = options.output.map(output => (output.plugins as Rolldown.Plugin[])[1])
    return { input, plugins }
  }
  const first = start()
  for (const plugin of first.plugins) {
    invokeHook(plugin, 'renderStart', {}, first.input)
    invokeHook(plugin, 'generateBundle', {}, outputBundle(), false)
  }
  expect(publications).toHaveLength(1)
  candidate = record('/two.ts')
  const second = start()
  invokeHook(second.plugins[0], 'renderStart', {}, second.input)
  invokeHook(second.plugins[0], 'generateBundle', {}, outputBundle('/two.ts'), false)
  expect(publications).toHaveLength(1)
  invokeHook(second.plugins[1], 'renderStart', {}, second.input)
  invokeHook(second.plugins[1], 'generateBundle', {}, outputBundle('/two.ts'), false)
  expect(publications).toHaveLength(2)
  expect(publications[1][0].moduleKey).toBe('/two.ts')
})
