import { z } from 'zod'
import type { IpcMainInvokeEvent } from 'electron'
import { createIpcInvoke } from '#/index'
import type { IpcInvokeFn } from '#/index'

const sum = createIpcInvoke('sum')
  .inputValidator(z.object({ a: z.number(), b: z.number().default(1) }))
  .handler(({ event, data }) => {
    const source: IpcMainInvokeEvent | undefined = event
    const b: number = data.b
    void source
    // @ts-expect-error Main direct calls have no event.
    const requiredEvent: IpcMainInvokeEvent = event
    void requiredEvent
    return data.a + b
  })
const result: Promise<number> = sum({ a: 2 })
void result
// @ts-expect-error Wrong argument type.
sum({ a: '2' })
// @ts-expect-error Missing required argument.
sum()
// @ts-expect-error Callers cannot provide event context.
sum({ a: 2 }, {} as IpcMainInvokeEvent)
// @ts-expect-error A schema is required.
createIpcInvoke('bad').inputValidator({})

const noInput = createIpcInvoke('no-input').handler(({ data, event }) => {
  const absent: undefined = data
  const source: IpcMainInvokeEvent | undefined = event
  void source
  // @ts-expect-error No validator means no handler input data.
  data.value
  return absent
})
const noInputResult: Promise<undefined> = noInput()
const noInputFn: IpcInvokeFn<undefined, undefined> = noInput
void noInputResult
void noInputFn
// @ts-expect-error No validator means callers cannot supply input data.
noInput({ value: 1 })
// @ts-expect-error A handler callback is still required.
createIpcInvoke('missing').handler()

const converted = createIpcInvoke('converted')
  .inputValidator(z.string().transform(async (value) => Number(value)))
  .handler(async ({ data }) => {
    const numeric: number = data
    // @ts-expect-error Handler sees transformed output, not schema input.
    const text: string = data
    void text
    return { numeric }
  })
const convertedResult: Promise<{ numeric: number }> = converted('42')
void convertedResult
// @ts-expect-error Call input is schema input, not schema output.
converted(42)

const empty = createIpcInvoke('empty').inputValidator(z.void()).handler(() => 1)
const emptyResult: Promise<number> = empty()
void emptyResult
