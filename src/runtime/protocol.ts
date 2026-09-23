import type { HotPayload } from 'vite'
import type { ModuleRunnerTransport } from 'vite/module-runner'
import type { DefinitionTarget } from '#/compiler/types'

export interface DevConnectionInfo {
  url: string
  token: string
}

export type InvokeResponse = Awaited<ReturnType<NonNullable<ModuleRunnerTransport['invoke']>>> & { invalidated?: string[] }

export interface ProviderRequest {
  requestId: string
  payload: HotPayload
  target?: DefinitionTarget
}

export interface ProviderMessage {
  requestId: string
  response: InvokeResponse
}
