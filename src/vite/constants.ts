import { IPC_IMPLEMENTATION_QUERY } from '#/constants'

export const MAIN_ENVIRONMENT = 'electron_main'
export const PRELOAD_ENVIRONMENT = 'electron_preload'

export const IPC_IMPLEMENTATION_ID_REGEX = new RegExp(
  `^[^?]*\\.[cm]?[jt]sx?\\?(?:[^&]*&)*${IPC_IMPLEMENTATION_QUERY}(?:&|$)`,
)

/** Source modules shared by compilation hooks. */
export const SOURCE_MODULE_FILTER = {
  include: /^[^?]*\.[cm]?[jt]sx?(?:\?|$)/,
  exclude: [
    /^\0/,
    /^[^?]*\.d\.[cm]?ts(?:\?|$)/,
    /^[^?]*\?(?:[^?&]*&)*(?:raw|url|worker|sharedworker)(?:=|&|\?|$)/,
  ],
}
