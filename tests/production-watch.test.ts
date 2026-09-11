import { expect, test } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'vite'
import type { Rolldown } from 'vite'
import type { Target } from '#/internal/options'
import { ipcInvoke } from '#/vite'
import { until, channels, ipcSource, sourceAliases } from './helpers'


for (const outputMode of ['single', 'array', 'library-default']) {
test(`production watchers follow renderer selection and recover with ${outputMode} outputs`, { timeout: 60000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(path.resolve(import.meta.dirname, '..'), '.ipc-test-production-watch-'))
  const watchers = new Map<Target, Rolldown.RolldownWatcher>()
  let releaseRenderer: (() => void) | undefined
  t.onTestFinished(async () => {
    releaseRenderer?.()
    for (const watcher of watchers.values()) await watcher.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  const definitionFile = path.join(root, 'src/ipc/value.ipc.ts')
  const rendererEntry = path.join(root, 'renderer.ts')
  const definition = (second = 'second') => ipcSource(`
    export const first = createIpcInvoke('first').inputValidator(z.void()).handler(() => 1);
    export const second = createIpcInvoke('${second}').inputValidator(z.void()).handler(() => 2);`)
  await fs.mkdir(path.dirname(definitionFile), { recursive: true })
  await fs.writeFile(definitionFile, definition())
  await fs.writeFile(rendererEntry, `export { first } from './src/ipc/value.ipc'`)
  for (const target of ['main', 'preload'] as const) await fs.writeFile(path.join(root, `${target}.ts`), '')

  const ipc = ipcInvoke()
  const outputs: { renderer?: string; main?: string[]; preload?: string[] } = {}
  const channelHistory: Record<'main' | 'preload', string[][]> = { main: [], preload: [] }
  const revisions = { renderer: 0, main: 0, preload: 0 }
  const errors: Record<Target, Error[]> = { renderer: [], main: [], preload: [] }
  let failSecondOutput = false
  let failFirstOutput = false
  let rendererGate: Promise<void> | undefined
  let rendererWaiting = false
  for (const target of ['renderer', 'main', 'preload'] as const) {
    let pendingOutput: string | undefined
    let succeeded = false
    const watcher = await build({
      root, configFile: false, logLevel: 'silent',
      resolve: { alias: sourceAliases },
      plugins: [ipc[target](), {
        name: 'capture-production-watch-output',
        async generateBundle(options) {
          if (target === 'renderer' && rendererGate) {
            rendererWaiting = true
            await rendererGate
          }
          if (target === 'renderer' && failFirstOutput && options.format === 'es') throw new Error('first renderer output failed')
          if (target === 'renderer' && failSecondOutput && outputMode !== 'array' && options.format === (outputMode === 'single' ? 'cjs' : 'umd')) {
            throw new Error('last renderer output failed')
          }
        },
        writeBundle(_options, bundle) {
          pendingOutput = Object.values(bundle).filter((item) => item.type === 'chunk').map((item) => item.code).join('\n')
        },
      }],
      build: {
        watch: {}, minify: false, outDir: `out-${target}`,
        lib: {
          entry: path.join(root, `${target}.ts`), fileName: (format) => `${target}.${format}.js`,
          ...(target === 'renderer' && outputMode === 'library-default' ? { name: 'ipcRendererTest' } : { formats: ['cjs'] }),
        },
        rolldownOptions: {
          external: ['electron'],
          ...(target === 'renderer' && outputMode === 'array' ? { output: [
            { format: 'es' },
            { format: 'cjs', plugins: [{
              name: 'fail-second-renderer-output',
              generateBundle() { if (failSecondOutput) throw new Error('second renderer output failed') },
            }] },
          ] } : {}),
        },
      },
    })
    if (Array.isArray(watcher) || !('on' in watcher)) throw new Error('Expected a build watcher')
    watchers.set(target, watcher)
    watcher.on('event', (event) => {
      if (event.code === 'START') { pendingOutput = undefined; succeeded = false }
      if (event.code === 'ERROR') { errors[target].push(event.error); succeeded = false }
      if (event.code === 'BUNDLE_END') succeeded = true
      if (event.code === 'END' && succeeded && pendingOutput !== undefined) {
        if (target === 'renderer') outputs.renderer = pendingOutput
        else {
          const selected = channels(pendingOutput)
          outputs[target] = selected
          channelHistory[target].push(selected)
        }
        revisions[target]++
      }
    })
    // Production targets still initialize strictly after the renderer has succeeded.
    await until(() => revisions[target] > 0, `initial ${target} build`)
  }
  const targetChannelsAre = (expected: string[]) => (['main', 'preload'] as const).every((target) => JSON.stringify(outputs[target]) === JSON.stringify(expected))
  const targetCheckpoint = () => Object.fromEntries((['main', 'preload'] as const).map((target) => [target, {
    channels: outputs[target], length: channelHistory[target].length,
  }]))
  const assertUnchanged = (checkpoint: ReturnType<typeof targetCheckpoint>) => {
    for (const target of ['main', 'preload'] as const) {
      expect(outputs[target]).toStrictEqual(checkpoint[target].channels)
      for (const actual of channelHistory[target].slice(checkpoint[target].length)) expect(actual).toStrictEqual(checkpoint[target].channels)
    }
  }
  expect(targetChannelsAre(['first'])).toBeTruthy()

  await fs.writeFile(rendererEntry, `export { first, second } from './src/ipc/value.ipc'`)
  await until(() => targetChannelsAre(['first', 'second']), 'adding a renderer-only reference')
  await fs.writeFile(rendererEntry, `export { second } from './src/ipc/value.ipc'`)
  await until(() => targetChannelsAre(['second']), 'removing a renderer-only reference')
  await fs.writeFile(rendererEntry, `export {}`)
  await until(() => targetChannelsAre([]), 'an empty renderer selection')

  const beforeFailure = targetCheckpoint()
  await fs.writeFile(rendererEntry, `import './missing'`)
  await until(() => errors.renderer.length > 0, 'renderer compile failure')
  await delay(150)
  assertUnchanged(beforeFailure)
  await fs.writeFile(rendererEntry, `export { first } from './src/ipc/value.ipc'`)
  await until(() => targetChannelsAre(['first']), 'renderer compile recovery')

  if (outputMode !== 'single') {
    failFirstOutput = true
    const beforeFirstOutputFailure = targetCheckpoint()
    const previousErrors = errors.renderer.length
    await fs.writeFile(rendererEntry, `export { second } from './src/ipc/value.ipc'`)
    await until(() => errors.renderer.length > previousErrors, 'first renderer output failure')
    await delay(150)
    assertUnchanged(beforeFirstOutputFailure)
    failFirstOutput = false
    await fs.appendFile(rendererEntry, '\n// retry first output')
    await until(() => targetChannelsAre(['second']), 'first renderer output recovery')
    await fs.writeFile(rendererEntry, `export { first } from './src/ipc/value.ipc'`)
    await until(() => targetChannelsAre(['first']), 'selection before last-output failure')
  }

  failSecondOutput = true
  const beforeOutputFailure = targetCheckpoint()
  const previousErrors = errors.renderer.length
  await fs.writeFile(rendererEntry, `export { second } from './src/ipc/value.ipc'`)
  await until(() => errors.renderer.length > previousErrors, 'second renderer output failure')
  await delay(150)
  assertUnchanged(beforeOutputFailure)
  failSecondOutput = false
  await fs.appendFile(rendererEntry, '\n// retry output')
  await until(() => targetChannelsAre(['second']), 'renderer output recovery')

  // Force dependent definition rebuilds to run before renderer output completes.
  // Its eventual selection notification must retry these failed target builds.
  rendererGate = new Promise<void>((resolve) => { releaseRenderer = resolve })
  const beforeDefinitionErrors = { main: errors.main.length, preload: errors.preload.length }
  await fs.writeFile(definitionFile, definition('renamed'))
  await until(() => rendererWaiting, 'held renderer output')
  await until(() => errors.main.length > beforeDefinitionErrors.main || errors.preload.length > beforeDefinitionErrors.preload, 'a dependent build waiting for renderer selection')
  rendererGate = undefined
  releaseRenderer!()
  await until(() => targetChannelsAre(['renamed']), 'definition change recovery')

  await watchers.get('preload')!.close()
  watchers.delete('preload')
  await fs.writeFile(rendererEntry, `export { first } from './src/ipc/value.ipc'`)
  await until(() => JSON.stringify(outputs.main) === JSON.stringify(['first']), 'updates after another target watcher closes')
})
}
