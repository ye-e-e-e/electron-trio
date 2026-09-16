import { expect, test } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Plugin, Rolldown } from 'vite'
import type { TestEvent } from './helpers'
import { ipcInvoke } from '#/vite'
import { fixture, bundle, ipcSource, definition, evaluate, electronHarness, entryCode, outputText, cjs, channels } from './helpers'

const valueModule = 'src/ipc/value.ipc.ts'
const entries = { 'renderer.ts': `export * from './src/ipc/value.ipc'`, 'main.ts': '', 'preload.ts': '' }

test('generated renderer, preload and main preserve validation, results and per-call events', async (t) => {
  const root = await fixture(t, {
    ...entries,
    [valueModule]: ipcSource(`
      import { app } from 'electron'
      import { secret } from './private'
      let validations = 0
      const inputSchema = z.string().transform(value => {
        validations++
        return Number(value)
      })
      export const read = createIpcInvoke('desktop:read')
        .inputValidator(inputSchema)
        .handler(async ({ data, event }) => ({ data, event, validations, version: app.getVersion(), secret }))
      export const noInput = createIpcInvoke('desktop:noInput').handler(({ data, event }) => ({ data, event }))
    `),
    'src/ipc/private.ts': `export const secret = 'MAIN_IMPLEMENTATION_SENTINEL'`,
    'main.ts': `export { read, noInput } from './src/ipc/value.ipc'`,
  })
  const [rendererPlugin, mainPlugin, preloadPlugin] = ipcInvoke({ bridgeName: 'desktop' })
  const renderer = await bundle(root, rendererPlugin, 'renderer.ts', cjs(root, 'renderer.ts'))
  const preload = await bundle(root, preloadPlugin, 'preload.ts', cjs(root, 'preload.ts'))
  const main = await bundle(root, mainPlugin, 'main.ts', cjs(root, 'main.ts'))
  for (const output of [renderer, preload]) {
    expect(outputText(output)).not.toMatch(/MAIN_IMPLEMENTATION_SENTINEL|Zod|~standard|validations|getVersion/)
  }
  type ReadResult = { data: number; event: TestEvent | undefined; validations: number; secret: string }
  type ReadModule = {
    read(input: unknown): Promise<ReadResult>
    noInput(input?: undefined): Promise<{ data: undefined; event: TestEvent | undefined }>
  }
  const { electron, handlers, bridges } = electronHarness<ReadResult>()
  const direct = evaluate<ReadModule>(entryCode(main), electron)
  evaluate(entryCode(preload), electron)
  const client = evaluate<ReadModule>(entryCode(renderer), {}, { desktop: bridges.get('desktop') })
  expect([...handlers.keys()].sort()).toStrictEqual(['desktop:noInput', 'desktop:read'])
  expect(structuredClone(await direct.noInput())).toStrictEqual({ data: undefined, event: undefined })
  // @ts-expect-error Extra IPC payload must not reach an unvalidated handler's data.
  expect(structuredClone(await client.noInput({ value: 1 }))).toStrictEqual({ data: undefined, event: { sender: { id: 1 } } })
  const local = await direct.read('1')
  expect(local.data).toBe(1)
  expect(local.event).toBe(undefined)
  const firstEvent = { sender: { id: 10 } }
  const secondEvent = { sender: { id: 20 } }
  const [first, second, remote] = await Promise.all([
    handlers.get('desktop:read')!(firstEvent, '2'),
    handlers.get('desktop:read')!(secondEvent, '3'),
    client.read('4'),
  ])
  expect(first.event).toBe(firstEvent)
  expect(second.event).toBe(secondEvent)
  expect(remote.event?.sender?.id).toBe(1)
  expect(remote.data).toBe(4)
  expect(remote.validations).toBe(4)
  expect(remote.secret).toBe('MAIN_IMPLEMENTATION_SENTINEL')
  await expect(client.read(4)).rejects.toThrow(/string/)
})

test('registration conflicts roll back new handlers without removing an existing handler', async (t) => {
  const root = await fixture(t, { ...entries, [valueModule]: ipcSource(`
    export const first = createIpcInvoke('first').inputValidator(z.void()).handler(() => 1)
    export const second = createIpcInvoke('second').inputValidator(z.void()).handler(() => 2)
  `) })
  const [rendererPlugin, mainPlugin] = ipcInvoke()
  await bundle(root, rendererPlugin, 'renderer.ts')
  const code = entryCode(await bundle(root, mainPlugin, 'main.ts', cjs(root, 'main.ts')))
  const { electron, handlers } = electronHarness()
  const foreign = () => 3
  handlers.set('second', foreign)
  expect(() => evaluate(code, electron)).toThrow(/Existing handler/)
  expect(handlers.has('first')).toBe(false)
  expect(handlers.get('second')).toBe(foreign)
  const clean = electronHarness()
  evaluate(code, clean.electron)
  expect(await clean.handlers.get('first')!({}, undefined)).toBe(1)
  expect(await clean.handlers.get('second')!({}, undefined)).toBe(2)
})

test('a symlink project root supports all three builds with the same IPC definitions', async (t) => {
  const root = await fixture(t, { ...entries, 'value.ipc.ts': definition('linked'), 'renderer.ts': `export * from './value.ipc'` })
  const linkedRoot = root + '-link'
  await fs.symlink(root, linkedRoot, 'dir')
  t.onTestFinished(() => fs.rm(linkedRoot, { force: true }))
  const [rendererPlugin, mainPlugin, preloadPlugin] = ipcInvoke()
  const plugins = { main: mainPlugin, preload: preloadPlugin }
  await bundle(linkedRoot, rendererPlugin, 'renderer.ts')
  for (const target of ['main', 'preload'] as const) {
    const entry = `${target}.ts`
    const output = await bundle(linkedRoot, plugins[target], entry, cjs(linkedRoot, entry))
    expect(channels(entryCode(output))).toStrictEqual(['linked'])
  }
})

test('production exposes retained channels across direct imports, barrels and lazy chunks', async (t) => {
  const root = await fixture(t, { ...entries,
    [valueModule]: ipcSource(`
      const local = createIpcInvoke('local').inputValidator(z.void()).handler(() => 'PRIVATE_HELPER')
      export const used = createIpcInvoke('used').inputValidator(z.void()).handler(() => local())
      export const lazy = createIpcInvoke('lazy').inputValidator(z.void()).handler(() => 2)
      export const dead = createIpcInvoke('dead').inputValidator(z.void()).handler(() => 3)
    `),
    'src/ipc/absent.ipc.ts': definition('absent'),
    'barrel.ts': `export { used } from './src/ipc/value.ipc'`,
    'lazy.ts': `export { lazy } from './src/ipc/value.ipc'`,
    'renderer.ts': `import { used } from './barrel'; import { dead } from './src/ipc/value.ipc'; if (false) dead(); globalThis.api = { used, load: () => import('./lazy') }`,
    'index.html': '<script type="module" src="/renderer.ts"></script>',
  })
  const [rendererPlugin, mainPlugin, preloadPlugin] = ipcInvoke()
  await expect(bundle(root, mainPlugin, 'main.ts')).rejects.toThrow(/renderer/i)
  const renderer = await bundle(root, rendererPlugin, 'renderer.ts', { lib: false, minify: true })
  expect(renderer.filter(({ type }) => type === 'chunk').length).toBeGreaterThan(1)
  expect(outputText(renderer)).not.toMatch(/PRIVATE_HELPER|~standard|Zod/)
  const selected = async () => channels(entryCode(await bundle(root, preloadPlugin, 'preload.ts', cjs(root, 'preload.ts'))))
  expect(await selected()).toStrictEqual(['lazy', 'used'])
  expect(outputText(await bundle(root, mainPlugin, 'main.ts'))).toMatch(/PRIVATE_HELPER/)
  await fs.writeFile(path.join(root, 'renderer.ts'), `import * as api from './src/ipc/value.ipc'; export const call = key => api[key]()`)
  await bundle(root, rendererPlugin, 'renderer.ts')
  expect(await selected()).toStrictEqual(['dead', 'lazy', 'used'])
  await fs.writeFile(path.join(root, 'renderer.ts'), '')
  await bundle(root, rendererPlugin, 'renderer.ts')
  expect(await selected()).toStrictEqual([])
})

test('all definitions are validated and implementation imports cannot cross into preload or excluded renderer scope', async (t) => {
  const root = await fixture(t, { ...entries, [valueModule]: definition('run') })
  await fs.writeFile(path.join(root, 'unimported.ipc.ts'), definition('run'))
  await expect(bundle(root, ipcInvoke()[0], 'renderer.ts')).rejects.toThrow(/Duplicate IPC channel.*value.ipc.ts|Duplicate IPC channel.*unimported.ipc.ts/)
  await fs.writeFile(path.join(root, 'unimported.ipc.ts'), 'export const broken = ;')
  await expect(bundle(root, ipcInvoke()[0], 'renderer.ts')).rejects.toThrow(/unimported.ipc.ts/)
  await fs.unlink(path.join(root, 'unimported.ipc.ts'))
  await expect(bundle(root, ipcInvoke({ exclude: ['**/value.ipc.ts'] })[0], 'renderer.ts')).rejects.toThrow(/outside include/)
  const [rendererPlugin, , preloadPlugin] = ipcInvoke()
  await bundle(root, rendererPlugin, 'renderer.ts')
  await fs.writeFile(path.join(root, 'preload.ts'), `import './src/ipc/value.ipc'`)
  await expect(bundle(root, preloadPlugin, 'preload.ts')).rejects.toThrow(/preload/)
})

test('failed renderer outputs do not provide an initial channel selection', async (t) => {
  const root = await fixture(t, { ...entries, [valueModule]: definition('run') })
  for (const phase of ['generateBundle', 'writeBundle']) {
    for (const location of ['input', 'output']) {
      const [rendererPlugin, , preloadPlugin] = ipcInvoke()
      const failure = { name: 'failure', [phase]: { order: 'post', async handler() { throw new Error('output failed') } } }
      await expect(bundle(root, [rendererPlugin, ...(location === 'input' ? [failure] : [])], 'renderer.ts', {
        write: phase === 'writeBundle', outDir: 'out-renderer',
        rolldownOptions: { output: { plugins: location === 'output' ? [failure] : [] } },
      })).rejects.toThrow(/output failed/)
      await expect(bundle(root, preloadPlugin, 'preload.ts')).rejects.toThrow(/renderer/i)
      await bundle(root, rendererPlugin, 'renderer.ts')
      expect(channels(entryCode(await bundle(root, preloadPlugin, 'preload.ts', cjs(root, 'preload.ts'))))).toStrictEqual(['run'])
    }
  }
})

test('all renderer outputs must finish before dependent builds can use their channels', async (t) => {
  const root = await fixture(t, { ...entries, [valueModule]: definition('run') })
  const [rendererPlugin, , preloadPlugin] = ipcInvoke()
  await expect(bundle(root, rendererPlugin, 'renderer.ts', {
    rolldownOptions: { output: [
      { format: 'es' }, { format: 'cjs', plugins: [{ name: 'failure', generateBundle() { throw new Error('last output failed') } }] },
    ] },
  })).rejects.toThrow(/last output failed/)
  await expect(bundle(root, preloadPlugin, 'preload.ts')).rejects.toThrow(/renderer/i)
  await bundle(root, rendererPlugin, 'renderer.ts', { lib: { entry: path.join(root, 'renderer.ts'), formats: ['es', 'cjs'] } })
  expect(channels(entryCode(await bundle(root, preloadPlugin, 'preload.ts', cjs(root, 'preload.ts'))))).toStrictEqual(['run'])
})

test('preload entries execute independently without loading a shared local bridge chunk', async (t) => {
  const root = await fixture(t, { ...entries, [valueModule]: definition('run'), 'other-preload.ts': '' })
  const [rendererPlugin, , preloadPlugin] = ipcInvoke()
  await bundle(root, rendererPlugin, 'renderer.ts')
  const output = await bundle(root, preloadPlugin, 'preload.ts', {
    lib: {
      entry: { first: path.join(root, 'preload.ts'), second: path.join(root, 'other-preload.ts') },
      formats: ['cjs'],
    },
  })
  const preloadEntries = output.filter((item): item is Rolldown.OutputChunk => item.type === 'chunk' && item.isEntry)
  expect(preloadEntries.length).toBe(2)
  for (const entry of preloadEntries) {
    const { electron, bridges } = electronHarness()
    evaluate(entry.code, electron)
    expect(Object.keys(bridges.get('__ipc')!)).toStrictEqual(['run'])
  }
})

test('a preceding plugin cannot silently change the IPC contract', async (t) => {
  const root = await fixture(t, { ...entries, [valueModule]: definition('run') })
  const changeChannel: Plugin = {
    name: 'change-channel', enforce: 'pre',
    transform(code, id) { if (id.endsWith('.ipc.ts')) return code.replace('"run"', '"different"') },
  }
  await expect(bundle(root, [changeChannel, ipcInvoke()[0]], 'renderer.ts')).rejects.toThrow(/preceding plugin changed IPC exports/)
})

test('entry initialization preserves shebangs and requires one main entry', async (t) => {
  const root = await fixture(t, { ...entries, [valueModule]: definition('run'), 'main.ts': '#!/usr/bin/env node\nexport const started = true', 'other-main.ts': '' })
  const [rendererPlugin, mainPlugin] = ipcInvoke()
  await bundle(root, rendererPlugin, 'renderer.ts')
  const main = await bundle(root, mainPlugin, 'main.ts', cjs(root, 'main.ts'))
  expect(entryCode(main)).toMatch(/^#!\/usr\/bin\/env node\n/)
  expect(channels(entryCode(main))).toStrictEqual(['run'])
  await expect(bundle(root, mainPlugin, 'main.ts', {
    lib: { entry: [path.join(root, 'main.ts'), path.join(root, 'other-main.ts')], formats: ['es'] },
  })).rejects.toThrow(/requires one entry/)
})
