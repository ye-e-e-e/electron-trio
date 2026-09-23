import type { DefinitionRecord } from '#/compiler/types'
import type { DevConnectionInfo } from '#/runtime/protocol'
import { DEV_RUNTIME_IMPORT, HANDLER_KEY } from '#/constants'
import { DEV_CHANNEL } from './constants'

export function devMainModule(connection: DevConnectionInfo) {
  return `import { ipcMain, app } from 'electron';
import { initRuntime, getRuntime } from ${JSON.stringify(DEV_RUNTIME_IMPORT)};
ipcMain.handle(${JSON.stringify(DEV_CHANNEL)}, async (event, moduleKey, exportName, input) => {
  if (typeof moduleKey !== 'string' || typeof exportName !== 'string' || !exportName) throw new TypeError('Invalid IPC invocation target');
  return (await getRuntime()).invoke({ caller: 'renderer', moduleKey, exportName }, event, input);
});
app.once('before-quit', event => {
  event.preventDefault();
  ipcMain.removeHandler(${JSON.stringify(DEV_CHANNEL)});
  void getRuntime().then(runtime => runtime.close()).catch(error => console.error(error)).finally(() => app.quit());
});
void initRuntime(${JSON.stringify(connection)}).catch(error => console.error('[electron-ipc-invoke]', error));`
}

export function mainModule(definitions: readonly DefinitionRecord[]): string {
  return [
    'import { ipcMain } from "electron";',
    ...definitions.map(({ exportName, moduleKey }, index) => `import { ${exportName} as ipc${index} } from ${JSON.stringify(moduleKey)};`),
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
