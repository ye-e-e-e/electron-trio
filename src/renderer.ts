/** Generated modules call this helper; applications import their typed .ipc.ts definitions. */
export function createRendererInvoker(channel: string, bridgeName = '__ipc') {
  return async (input: unknown): Promise<unknown> => {
    const bridge = (globalThis as Record<string, unknown>)[bridgeName]
    if (!bridge || typeof bridge !== 'object' || !Object.hasOwn(bridge, channel)) {
      throw new Error(`IPC bridge ${JSON.stringify(bridgeName)} is missing channel ${JSON.stringify(channel)}. Check the preload configuration.`)
    }
    const invoke = (bridge as Record<string, unknown>)[channel]
    if (typeof invoke !== 'function') throw new Error(`Invalid IPC bridge method: ${channel}`)
    return invoke(input)
  }
}
