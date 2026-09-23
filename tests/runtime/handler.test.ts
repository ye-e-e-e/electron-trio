import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { createIpcInvoke, IpcValidationError } from '#/index'

test('without a validator, direct calls receive undefined data even when passed an undeclared payload', async () => {
  const run = createIpcInvoke('no-input').handler(({ data, event }) => ({ data, event }))
  expect(await run()).toStrictEqual({ data: undefined, event: undefined })
  // @ts-expect-error Exercise an untyped caller supplying undeclared input.
  expect(await run({ value: 1 })).toStrictEqual({ data: undefined, event: undefined })
})

test.each([false, true])('direct calls validate once, use schema output and have no Electron event (async: %s)', async (asynchronous) => {
  const input = z.string().transform((value) => {
    const result = Number(value)
    return asynchronous ? Promise.resolve(result) : result
  })
  const validate = vi.spyOn(input['~standard'], 'validate')
  const run = createIpcInvoke('convert').inputValidator(input).handler(async ({ data, event }) => ({ data, event }))
  expect(await Promise.all([run('1'), run('2')])).toStrictEqual([
    { data: 1, event: undefined }, { data: 2, event: undefined },
  ])
  expect(validate).toHaveBeenCalledTimes(2)
})

test('validation issues prevent execution and preserve issue details for direct callers', async () => {
  const input = z.object({ profile: z.object({ name: z.string() }) })
  const invalid = { profile: { name: 1 } }
  const issues = input.safeParse(invalid).error!.issues
  const handler = vi.fn()
  const run = createIpcInvoke('invalid').inputValidator(input).handler(handler)
  // @ts-expect-error Exercise runtime validation of an invalid caller.
  const error = await run(invalid).catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(IpcValidationError)
  expect((error as IpcValidationError).issues).toStrictEqual(issues)
  expect((error as IpcValidationError).message).toBe(JSON.stringify(issues, null, 2))
  expect(handler).not.toHaveBeenCalled()
})

test.each([
  ['circular references', () => {
    const details: { self?: unknown } = {}
    details.self = details
    return details
  }],
  ['BigInt values', () => 1n],
  ['throwing toJSON methods', () => ({ toJSON() { throw new Error('Serialization failed') } })],
])('non-serializable validation issues preserve messages and original details: %s', async (_, createDetails) => {
  const details = createDetails()
  const issues = [
    { message: 'Invalid input', details },
    { message: 'Another validation failure', path: ['value'] },
  ]
  const input = z.unknown()
  vi.spyOn(input['~standard'], 'validate').mockReturnValue({ issues })
  const handler = vi.fn()
  const run = createIpcInvoke('invalid-details').inputValidator(input).handler(handler)
  const error = await run(undefined).catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(IpcValidationError)
  expect((error as IpcValidationError).name).toBe('IpcValidationError')
  expect((error as IpcValidationError).issues).toBe(issues)
  expect((error as IpcValidationError).message).toBe(JSON.stringify([
    { message: 'Invalid input' },
    { message: 'Another validation failure' },
  ], null, 2))
  expect(handler).not.toHaveBeenCalled()
})

test('validator and handler failures reject the returned Promise; undefined output is valid', async () => {
  const error = new Error('Failure')
  for (const fail of [() => { throw error }, async () => { throw error }]) {
    const input = z.unknown()
    vi.spyOn(input['~standard'], 'validate').mockImplementation(fail)
    const handler = vi.fn()
    for (const run of [
      createIpcInvoke('validator').inputValidator(input).handler(handler),
      createIpcInvoke('handler').inputValidator(z.void()).handler(fail),
      createIpcInvoke('no-validator').handler(fail),
    ]) {
      let promise: Promise<unknown> | undefined
      expect(() => { promise = run(undefined) }).not.toThrow()
      await expect(promise).rejects.toBe(error)
    }
    expect(handler).not.toHaveBeenCalled()
  }
  expect(await createIpcInvoke('void').inputValidator(z.void()).handler(({ data }) => data)()).toBeUndefined()
})

test('Zod works through Standard Schema with async transforms, defaults and refinements', async () => {
  const run = createIpcInvoke('zod').inputValidator(z.object({
    value: z.string().transform(async (value) => Number(value)),
    name: z.string().default('default'),
  }).refine(async ({ value }) => value > 0, 'Must be positive')).handler(({ data }) => data)
  expect(await run({ value: '2' })).toStrictEqual({ value: 2, name: 'default' })
  await expect(run({ value: '-1' })).rejects.toThrow(/Must be positive/)
  // @ts-expect-error Exercise runtime validation of an invalid caller.
  await expect(run({ value: 3 })).rejects.toThrow(IpcValidationError)
})
