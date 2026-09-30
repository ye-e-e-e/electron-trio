import fs from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from 'vite'
import { expect, test } from 'vitest'
import { ipcMainPlugin } from '#/vite/ipc-main-plugin/plugin'
import { IpcContext } from '#/vite/ipc-plugin/context'
import type { TestEvent } from '../helpers'
import { ipcPlugins } from '../helpers'
import {
  fixture,
  bundle,
  ipcSource,
  definition,
  evaluate,
  electronHarness,
  entryCode,
  outputText,
  cjs,
  channels,
  mainRunner,
} from '../helpers'

const valueModule = 'src/ipc/value.ts'
const entries = {
  'renderer.ts': `export * from './src/ipc/value'`,
  'main.ts': '',
  'preload.ts': '',
}

test.for(['raw', 'url'])(
  'resource imports with ?%s preserve Vite behavior in renderer and main',
  async (query, t) => {
    const root = await fixture(t, {
      'definition.ts': definition('run'),
      'entry.ts': `import text from './definition.ts?${query}'; export { text }`,
    })
    const options = cjs(root, 'entry.ts')
    const baseline = evaluate(
      entryCode(await bundle(root, [], 'entry.ts', options)),
    )
    const context = new IpcContext({})
    expect(
      evaluate(
        entryCode(await bundle(root, ipcPlugins(), 'entry.ts', options)),
      ),
    ).toEqual(baseline)
    const original = await mainRunner(t, root, [])
    const main = await mainRunner(t, root, ipcMainPlugin(context))
    expect((await main.runner.import(path.join(root, 'entry.ts'))).text).toBe(
      (await original.runner.import(path.join(root, 'entry.ts'))).text,
    )
  },
)

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
    'main.ts': `export { read, noInput } from './src/ipc/value'`,
  })
  const plugins = ipcPlugins({ bridgeName: 'desktop' })
  const renderer = await bundle(
    root,
    plugins,
    'renderer.ts',
    cjs(root, 'renderer.ts'),
  )
  const preload = await bundle(
    root,
    plugins,
    'preload.ts',
    cjs(root, 'preload.ts'),
    'electron_preload',
  )
  const main = await bundle(
    root,
    plugins,
    'main.ts',
    cjs(root, 'main.ts'),
    'electron_main',
  )
  for (const output of [renderer, preload]) {
    expect(outputText(output)).not.toMatch(
      /MAIN_IMPLEMENTATION_SENTINEL|Zod|~standard|validations|getVersion/,
    )
  }
  type ReadResult = {
    data: number
    event: TestEvent | undefined
    validations: number
    secret: string
  }
  type ReadModule = {
    read(input: unknown): Promise<ReadResult>
    noInput(
      input?: undefined,
    ): Promise<{ data: undefined; event: TestEvent | undefined }>
  }
  const { electron, handlers, bridges } = electronHarness<ReadResult>()
  const direct = evaluate<ReadModule>(entryCode(main), electron)
  evaluate(entryCode(preload), electron)
  const client = evaluate<ReadModule>(
    entryCode(renderer),
    {},
    { desktop: bridges.get('desktop') },
  )
  expect([...handlers.keys()].sort()).toStrictEqual([
    'desktop:noInput',
    'desktop:read',
  ])
  expect(structuredClone(await direct.noInput())).toStrictEqual({
    data: undefined,
    event: undefined,
  })
  // @ts-expect-error Extra IPC payload must not reach an unvalidated handler's data.
  expect(structuredClone(await client.noInput({ value: 1 }))).toStrictEqual({
    data: undefined,
    event: { sender: { id: 1 } },
  })
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
  const root = await fixture(t, {
    ...entries,
    [valueModule]: ipcSource(`
    export const first = createIpcInvoke('first').inputValidator(z.void()).handler(() => 1)
    export const second = createIpcInvoke('second').inputValidator(z.void()).handler(() => 2)
  `),
  })
  const plugins = ipcPlugins()
  await bundle(root, plugins, 'renderer.ts')
  const code = entryCode(
    await bundle(
      root,
      plugins,
      'main.ts',
      cjs(root, 'main.ts'),
      'electron_main',
    ),
  )
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
  const root = await fixture(t, {
    ...entries,
    'value.ipc.ts': definition('linked'),
    'renderer.ts': `export * from './value.ipc'`,
  })
  const linkedRoot = root + '-link'
  await fs.symlink(root, linkedRoot, 'dir')
  t.onTestFinished(() => fs.rm(linkedRoot, { force: true }))
  const plugins = ipcPlugins()
  await bundle(linkedRoot, plugins, 'renderer.ts')
  for (const target of ['main', 'preload'] as const) {
    const entry = `${target}.ts`
    const output = await bundle(
      linkedRoot,
      plugins,
      entry,
      cjs(linkedRoot, entry),
      target === 'main' ? 'electron_main' : 'electron_preload',
    )
    expect(channels(entryCode(output))).toStrictEqual(['linked'])
  }
})

test('production exposes retained channels across direct imports, barrels and lazy chunks', async (t) => {
  const root = await fixture(t, {
    ...entries,
    [valueModule]: ipcSource(`
      const local = createIpcInvoke('local').inputValidator(z.void()).handler(() => 'PRIVATE_HELPER')
      export const used = createIpcInvoke('used').inputValidator(z.void()).handler(() => local())
      export const lazy = createIpcInvoke('lazy').inputValidator(z.void()).handler(() => 2)
      export const dead = createIpcInvoke('dead').inputValidator(z.void()).handler(() => 3)
    `),
    'src/ipc/absent.ipc.ts': definition('absent'),
    'barrel.ts': `export { used as renamed } from './src/ipc/value'`,
    'lazy.ts': `export { lazy } from './src/ipc/value'`,
    'renderer.ts': `import { renamed as used } from './barrel'; import { dead } from './src/ipc/value'; if (false) dead(); globalThis.api = { used, load: () => import('./lazy') }`,
    'index.html': '<script type="module" src="/renderer.ts"></script>',
  })
  const plugins = ipcPlugins()
  await expect(
    bundle(root, plugins, 'main.ts', {}, 'electron_main'),
  ).rejects.toThrow(/renderer/i)
  const renderer = await bundle(root, plugins, 'renderer.ts', {
    lib: false,
    minify: true,
  })
  expect(
    renderer.filter(({ type }) => type === 'chunk').length,
  ).toBeGreaterThan(1)
  expect(outputText(renderer)).not.toMatch(/PRIVATE_HELPER|~standard|Zod/)
  const selected = async () =>
    channels(
      entryCode(
        await bundle(
          root,
          plugins,
          'preload.ts',
          cjs(root, 'preload.ts'),
          'electron_preload',
        ),
      ),
    )
  expect(await selected()).toStrictEqual(['lazy', 'used'])
  expect(
    outputText(await bundle(root, plugins, 'main.ts', {}, 'electron_main')),
  ).toMatch(/PRIVATE_HELPER/)
  await fs.writeFile(
    path.join(root, 'renderer.ts'),
    `import * as api from './src/ipc/value'; export const call = key => api[key]()`,
  )
  await bundle(root, plugins, 'renderer.ts')
  expect(await selected()).toStrictEqual(['dead', 'lazy', 'used'])
  await fs.writeFile(path.join(root, 'renderer.ts'), '')
  await bundle(root, plugins, 'renderer.ts')
  expect(await selected()).toStrictEqual([])
})

test('direct renderer proxies support exports named like the generated factory binding', async (t) => {
  const root = await fixture(t, {
    ...entries,
    [valueModule]: ipcSource(`
      export const __ipcInvoke = createIpcInvoke('first').handler(() => 1)
      export const __ipcInvoke_ = createIpcInvoke('second').handler(() => 2)
      export const createRendererInvoker = createIpcInvoke('third').handler(() => 3)
    `),
  })
  const plugins = ipcPlugins()
  const renderer = await bundle(
    root,
    plugins,
    'renderer.ts',
    cjs(root, 'renderer.ts'),
  )
  const api = evaluate(
    entryCode(renderer),
    {},
    {
      __ipc: {
        first: () => 1,
        second: () => 2,
        third: () => 3,
      },
    },
  )
  expect(await api.__ipcInvoke()).toBe(1)
  expect(await api.__ipcInvoke_()).toBe(2)
  expect(await api.createRendererInvoker()).toBe(3)
  expect(
    channels(
      entryCode(
        await bundle(
          root,
          plugins,
          'preload.ts',
          cjs(root, 'preload.ts'),
          'electron_preload',
        ),
      ),
    ),
  ).toEqual(['first', 'second', 'third'])
})

test('unimported invalid definitions are ignored', async (t) => {
  const root = await fixture(t, {
    ...entries,
    [valueModule]: definition('run'),
  })
  await fs.writeFile(path.join(root, 'unimported.ts'), definition('run'))
  await bundle(root, ipcPlugins(), 'renderer.ts')
  await fs.writeFile(
    path.join(root, 'unimported.ts'),
    'export const broken = ;',
  )
  await bundle(root, ipcPlugins(), 'renderer.ts')
})

test('encountered modules validate all public definitions, including unused exports', async (t) => {
  const root = await fixture(t, {
    ...entries,
    [valueModule]:
      definition('valid') +
      `\nexport const invalid = createIpcInvoke(channel).handler(() => 2)`,
    'renderer.ts': `export { run } from './src/ipc/value'`,
  })
  await expect(bundle(root, ipcPlugins(), 'renderer.ts')).rejects.toThrow(
    /value.ts/,
  )
})

test('active duplicate channels report both ordinary filenames', async (t) => {
  const root = await fixture(t, {
    ...entries,
    [valueModule]: definition('duplicate'),
    'other.ts': definition('duplicate'),
    'renderer.ts': `export { run as first } from './src/ipc/value'; export { run as second } from './other'`,
  })
  await expect(bundle(root, ipcPlugins(), 'renderer.ts')).rejects.toThrow(
    /Duplicate IPC channel.*(?:value.ts.*other.ts|other.ts.*value.ts)/,
  )
})

test('ordinary runtime exports and private factory calls remain local modules', async (t) => {
  const root = await fixture(t, {
    'renderer.ts': `import { createIpcInvoke } from 'electron-trio';
      const privateFn = createIpcInvoke('private').handler(() => 7);
      export const ordinary = () => privateFn(); export const value = 3`,
    'preload.ts': '',
  })
  const plugins = ipcPlugins()
  const code = entryCode(
    await bundle(root, plugins, 'renderer.ts', cjs(root, 'renderer.ts')),
  )
  const exports = evaluate<{ ordinary(): Promise<number>; value: number }>(code)
  expect(await exports.ordinary()).toBe(7)
  expect(exports.value).toBe(3)
  expect(
    channels(
      entryCode(
        await bundle(
          root,
          plugins,
          'preload.ts',
          cjs(root, 'preload.ts'),
          'electron_preload',
        ),
      ),
    ),
  ).toEqual([])
})

test('failed renderer outputs do not provide an initial channel selection', async (t) => {
  const root = await fixture(t, {
    ...entries,
    [valueModule]: definition('run'),
  })
  for (const phase of ['generateBundle', 'writeBundle']) {
    for (const location of ['input', 'output']) {
      const plugins = ipcPlugins()
      const failure = {
        name: 'failure',
        [phase]: {
          order: 'post',
          async handler() {
            throw new Error('output failed')
          },
        },
      }
      await expect(
        bundle(
          root,
          [plugins, ...(location === 'input' ? [failure] : [])],
          'renderer.ts',
          {
            write: phase === 'writeBundle',
            outDir: 'out-renderer',
            rolldownOptions: {
              output: { plugins: location === 'output' ? [failure] : [] },
            },
          },
        ),
      ).rejects.toThrow(/output failed/)
      await expect(
        bundle(root, plugins, 'preload.ts', {}, 'electron_preload'),
      ).rejects.toThrow(/renderer/i)
      await bundle(root, plugins, 'renderer.ts')
      expect(
        channels(
          entryCode(
            await bundle(
              root,
              plugins,
              'preload.ts',
              cjs(root, 'preload.ts'),
              'electron_preload',
            ),
          ),
        ),
      ).toStrictEqual(['run'])
    }
  }
})

test('all renderer outputs must finish before dependent builds can use their channels', async (t) => {
  const root = await fixture(t, {
    ...entries,
    [valueModule]: definition('run'),
  })
  const plugins = ipcPlugins()
  await expect(
    bundle(root, plugins, 'renderer.ts', {
      rolldownOptions: {
        output: [
          { format: 'es' },
          {
            format: 'cjs',
            plugins: [
              {
                name: 'failure',
                generateBundle() {
                  throw new Error('last output failed')
                },
              },
            ],
          },
        ],
      },
    }),
  ).rejects.toThrow(/last output failed/)
  await expect(
    bundle(root, plugins, 'preload.ts', {}, 'electron_preload'),
  ).rejects.toThrow(/renderer/i)
  await bundle(root, plugins, 'renderer.ts', {
    lib: { entry: path.join(root, 'renderer.ts'), formats: ['es', 'cjs'] },
  })
  expect(
    channels(
      entryCode(
        await bundle(
          root,
          plugins,
          'preload.ts',
          cjs(root, 'preload.ts'),
          'electron_preload',
        ),
      ),
    ),
  ).toStrictEqual(['run'])
})

test('preload requires one entry', async (t) => {
  const root = await fixture(t, {
    ...entries,
    [valueModule]: definition('run'),
    'other-preload.ts': '',
  })
  const plugins = ipcPlugins()
  await bundle(root, plugins, 'renderer.ts')
  await expect(
    bundle(
      root,
      plugins,
      'preload.ts',
      {
        lib: {
          entry: {
            first: path.join(root, 'preload.ts'),
            second: path.join(root, 'other-preload.ts'),
          },
          formats: ['cjs'],
        },
      },
      'electron_preload',
    ),
  ).rejects.toThrow('IPC preload requires one entry')
})

test('IPC compilation uses the source returned by preceding transforms', async (t) => {
  const root = await fixture(t, {
    ...entries,
    [valueModule]: definition('run'),
  })
  const changeChannel: Plugin = {
    name: 'change-channel',
    enforce: 'pre',
    transform(code, id) {
      if (id.endsWith('/value.ts')) return code.replace('"run"', '"different"')
    },
  }
  const plugins = [changeChannel, ipcPlugins()]
  const renderer = await bundle(root, plugins, 'renderer.ts')
  expect(outputText(renderer)).toContain('different')
  expect(
    channels(
      entryCode(
        await bundle(
          root,
          plugins,
          'main.ts',
          cjs(root, 'main.ts'),
          'electron_main',
        ),
      ),
    ),
  ).toEqual(['different'])
  expect(
    channels(
      entryCode(
        await bundle(
          root,
          plugins,
          'preload.ts',
          cjs(root, 'preload.ts'),
          'electron_preload',
        ),
      ),
    ),
  ).toEqual(['different'])
})

test('entry initialization preserves shebangs and requires one main entry', async (t) => {
  const root = await fixture(t, {
    ...entries,
    [valueModule]: definition('run'),
    'main.ts': '#!/usr/bin/env node\nexport const started = true',
    'other-main.ts': '',
  })
  const plugins = ipcPlugins()
  await bundle(root, plugins, 'renderer.ts')
  const main = await bundle(
    root,
    plugins,
    'main.ts',
    cjs(root, 'main.ts'),
    'electron_main',
  )
  expect(entryCode(main)).toMatch(/^#!\/usr\/bin\/env node\n/)
  expect(channels(entryCode(main))).toStrictEqual(['run'])
  await expect(
    bundle(
      root,
      plugins,
      'main.ts',
      {
        lib: {
          entry: [path.join(root, 'main.ts'), path.join(root, 'other-main.ts')],
          formats: ['es'],
        },
      },
      'electron_main',
    ),
  ).rejects.toThrow(/requires one entry/)
})
