import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import { ModuleRunner, createNodeImportMeta } from 'vite/module-runner'
import { IPC_DISPATCHER_MODULE } from '#/vite/ipc-dispatcher-plugin/constants'
import type { IpcDispatcherModule } from '#/vite/ipc-dispatcher-plugin/dispatcher-module'
import { createConnection } from './connection'
import { createIpcDispatcher } from './ipc-dispatcher'
import type {
  ElectronBootstrapConfig,
  ElectronProcessMessage,
} from './protocol'

/** Initialize the development runner and dispatcher before loading application main. */
process.once('disconnect', () => app.exit())

try {
  const config: ElectronBootstrapConfig = JSON.parse(
    process.env.ELECTRON_START_RUNNER!,
  )
  // Electron's CLI uses this runtime method, but it is absent from its public typings.
  const electronApp = app as typeof app & {
    setAppPath(path: string): void
    setVersion(version: string): void
  }
  electronApp.setAppPath(config.root)
  try {
    const metadata = JSON.parse(
      await fs.readFile(path.join(config.root, 'package.json'), 'utf8'),
    )
    if (metadata.productName || metadata.name)
      app.setName(metadata.productName || metadata.name)
    if (metadata.version) electronApp.setVersion(metadata.version)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const { transport, validate } = createConnection()
  const runner = new ModuleRunner({
    transport,
    createImportMeta: createNodeImportMeta,
    hmr: true,
  })
  const dispatcher = createIpcDispatcher({ runner, validate })
  process.on('message', (message: unknown) => {
    const data = message as ElectronProcessMessage | null
    if (data?.type === 'electron:reload')
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.reload()
    if (data?.type === 'electron:quit') app.quit()
  })
  const dispatcherModule = await runner.import<IpcDispatcherModule>(
    IPC_DISPATCHER_MODULE,
  )
  dispatcherModule.setDispatcher(dispatcher)
  await runner.import(config.entry)
} catch (error) {
  console.error(error)
  app.exit(1)
}
