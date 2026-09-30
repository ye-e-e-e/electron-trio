import path from 'node:path'
import type { Plugin } from 'vite'
import { MAIN_ENVIRONMENT } from '#/vite/constants'
import type { ElectronTrioViteOptions } from '#/vite/types'
import { createElectronEnvironment } from './environment'
import type { ElectronDevEnvironment } from './environment'

export function electronPlugin(options: ElectronTrioViteOptions): Plugin {
  const plugin: Plugin = {
    name: 'electron-trio:electron-main',
    config: {
      order: 'pre',
      handler(config) {
        const root = path.resolve(config.root ?? process.cwd())
        const outDir = config.build?.outDir ?? 'dist'
        config.base ??= './'
        const environments = (config.environments ??= {})
        const client = (environments.client ??= {})
        const clientBuild = (client.build ??= {})
        clientBuild.outDir ??= path.join(outDir, 'client')

        // Assign the merged environment so Vite does not append user arrays a second time.
        environments[MAIN_ENVIRONMENT] = createElectronEnvironment(
          {
            entry: path.resolve(root, options.entry),
            outDir: path.join(outDir, 'main'),
            electron: options.electron,
          },
          environments[MAIN_ENVIRONMENT],
        )
        return {
          builder: { sharedConfigBuild: true },
        }
      },
    },
    async buildApp(builder) {
      for (const name of ['client', MAIN_ENVIRONMENT]) {
        const environment = builder.environments[name]
        if (environment && !environment.isBuilt)
          await builder.build(environment)
      }
    },
    async configureServer(server) {
      if (!server.httpServer)
        throw new Error('Electron development requires a Vite HTTP server')
      const environment = server.environments[
        MAIN_ENVIRONMENT
      ] as ElectronDevEnvironment
      server.httpServer.once('listening', () => {
        const address = server.httpServer!.address()
        if (!address || typeof address === 'string') return
        const host = server.config.server.host
        const hostname =
          typeof host === 'string' && host !== '0.0.0.0' && host !== '::'
            ? host
            : 'localhost'
        const rendererUrl = `${server.config.server.https ? 'https' : 'http'}://${hostname.includes(':') ? `[${hostname}]` : hostname}:${address.port}${server.config.base}`
        void environment.electron
          .start({
            root: server.config.root,
            entry: path.resolve(server.config.root, options.entry),
            rendererUrl,
          })
          .catch((error) => {
            server.config.logger.error(String(error))
            void server.close()
          })
      })
    },
  }
  return plugin
}
