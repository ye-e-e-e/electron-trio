import type { DefinitionRecord } from '#/compiler/types'
import { HANDLER_KEY } from '#/constants'
import { IPC_DISPATCHER_MODULE } from '#/vite/ipc-dispatcher-plugin/constants'
import { DEV_CHANNEL } from './constants'

export function devMainModule() {
  return `import { ipcMain } from 'electron';
import { getDispatcher } from ${JSON.stringify(IPC_DISPATCHER_MODULE)};
ipcMain.handle(${JSON.stringify(DEV_CHANNEL)}, async (event, moduleKey, exportName, input) => {
  if (typeof moduleKey !== 'string' || typeof exportName !== 'string' || !exportName) throw new TypeError('Invalid IPC invocation target');
  return getDispatcher().invoke({ caller: 'renderer', moduleKey, exportName }, event, input);
});`
}

export function mainModule(definitions: readonly DefinitionRecord[]): string {
  return [
    'import { ipcMain } from "electron";',
    ...definitions.map(
      ({ exportName, moduleKey }, index) =>
        `import { ${exportName} as ipc${index} } from ${JSON.stringify(moduleKey)};`,
    ),
    `const handlers = [${definitions.map(({ channel }, index) => `[${JSON.stringify(channel)}, ipc${index}]`).join(', ')}];`,
    'const registered = [];',
    'try {',
    '  for (const [channel, invoke] of handlers) {',
    `    const execute = invoke[Symbol.for(${JSON.stringify(HANDLER_KEY)})];`,
    '    if (typeof execute !== "function") throw new TypeError(`Invalid IPC definition: ${channel}`);',
    '    ipcMain.handle(channel, execute);',
    '    registered.push(channel);',
    '  }',
    '} catch (error) {',
    '  for (const channel of registered) ipcMain.removeHandler(channel);',
    '  throw error;',
    '}',
  ].join('\n')
}
