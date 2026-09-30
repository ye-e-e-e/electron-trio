/** Browser-only helpers served and bundled through the renderer virtual module. */
export function rendererModule(bridgeName: string): string {
  return `const bridgeName = ${JSON.stringify(bridgeName)};

export function createRendererInvoker(channel) {
  return async (input) => {
    const bridge = globalThis[bridgeName];
    if (!bridge || typeof bridge !== 'object' || !Object.hasOwn(bridge, channel)) {
      throw new Error('IPC bridge ' + JSON.stringify(bridgeName) + ' is missing channel ' + JSON.stringify(channel) + '. Check the preload configuration.');
    }
    const invoke = bridge[channel];
    if (typeof invoke !== 'function') throw new Error('Invalid IPC bridge method: ' + channel);
    return invoke(input);
  };
}

export function createDevRendererInvoker(moduleKey, exportName) {
  return async (input) => {
    const bridge = globalThis[bridgeName];
    if (!bridge || typeof bridge.invoke !== 'function') throw new Error('IPC development bridge ' + JSON.stringify(bridgeName) + ' is unavailable. Check the preload configuration.');
    return bridge.invoke(moduleKey, exportName, input);
  };
}`
}
