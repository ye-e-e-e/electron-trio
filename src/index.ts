import type { IpcMainInvokeEvent } from 'electron'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { HANDLER_KEY } from './internal/runtime-key.js'

export interface IpcInvokeContext<Data> {
  event: IpcMainInvokeEvent | undefined
  data: Data
}

export type IpcInvokeFn<Schema extends StandardSchemaV1 | undefined, Result> = (
  input: Schema extends StandardSchemaV1 ? StandardSchemaV1.InferInput<Schema> : void
) => Promise<Awaited<Result>>

/** Available to direct callers; Electron transports only the error message. */
export class IpcValidationError extends Error {
  constructor(readonly issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    super(JSON.stringify(issues, null, 2))
    this.name = 'IpcValidationError'
  }
}

function createHandler<Input, Data>(readData: (input: unknown) => Data | Promise<Data>) {
  return function handler<Result>(fn: (context: IpcInvokeContext<Data>) => Result) {
    if (typeof fn !== 'function') throw new TypeError('IPC handler must be a function')
    const execute = async (event: IpcMainInvokeEvent | undefined, input: unknown): Promise<Awaited<Result>> => {
      const data = await readData(input)
      return await fn({ event, data })
    }
    const invoke = (input: Input) => execute(undefined, input)
    Object.defineProperty(invoke, Symbol.for(HANDLER_KEY), { value: execute })
    return invoke
  }
}

export function createIpcInvoke(channel: string) {
  if (typeof channel !== 'string' || !channel.trim()) {
    throw new TypeError('IPC channel must be a non-empty string')
  }
  return {
    handler: createHandler<void, undefined>(() => undefined),
    inputValidator<Schema extends StandardSchemaV1>(schema: Schema) {
      const standard = schema?.['~standard']
      if (standard?.version !== 1 || typeof standard.validate !== 'function') {
        throw new TypeError('Expected a StandardSchemaV1 input schema')
      }
      return {
        handler: createHandler<StandardSchemaV1.InferInput<Schema>, StandardSchemaV1.InferOutput<Schema>>(async (input) => {
          const result = await standard.validate(input)
          if (result.issues) throw new IpcValidationError(result.issues)
          return result.value
        }),
      }
    },
  }
}
