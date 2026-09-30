import { isAbsolute } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type { ModuleRunner } from 'vite/module-runner'
import type { DefinitionTarget } from '#/compiler/types'
import { HANDLER_KEY, IPC_IMPLEMENTATION_QUERY } from '#/constants'

export interface IpcDispatcher {
  invoke(
    target: DefinitionTarget,
    event: IpcMainInvokeEvent | undefined,
    input: unknown,
  ): Promise<unknown>
}

export interface IpcDispatcherOptions {
  runner: Pick<ModuleRunner, 'import'>
  validate(target: DefinitionTarget): Promise<void>
}

/** Dispatch through the main runner; this instance never creates a module loader. */
export function createIpcDispatcher({
  runner,
  validate,
}: IpcDispatcherOptions): IpcDispatcher {
  return {
    async invoke(target, event, input) {
      if (
        !isAbsolute(target.moduleKey) ||
        !target.exportName ||
        !['main', 'renderer'].includes(target.caller)
      ) {
        throw new TypeError('Invalid IPC invocation target')
      }
      await validate(target)
      const exports = await runner.import<Record<string, unknown>>(
        `${target.moduleKey}?${IPC_IMPLEMENTATION_QUERY}`,
      )
      const handler = exports[target.exportName] as
        | { [key: symbol]: unknown }
        | undefined
      const execute = handler?.[Symbol.for(HANDLER_KEY)]
      if (typeof execute !== 'function')
        throw new Error(
          `IPC definition ${target.moduleKey}:${target.exportName} is unavailable`,
        )
      return execute(event, input)
    },
  }
}
