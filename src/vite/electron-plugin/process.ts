import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Logger } from 'vite'
import type {
  ElectronBootstrapConfig,
  ElectronProcessMessage,
} from '#/runtime/protocol'
import type { ElectronOptions } from './types'

/** Owns only the Electron process; it does not resolve or execute application modules. */
export class ElectronProcess {
  child?: ChildProcess
  private config?: ElectronBootstrapConfig
  private work = Promise.resolve()
  private closed = false

  constructor(
    private readonly options: ElectronOptions,
    private readonly logger: Logger,
    private readonly connect: (child: ChildProcess) => void,
  ) {}

  start(config: ElectronBootstrapConfig) {
    this.config = config
    const work = this.work.then(async () => {
      await this.stop()
      if (this.closed) return
      const require = createRequire(path.join(config.root, 'package.json'))
      const binary =
        process.env.ELECTRON_BINARY ?? (require('electron') as string)
      const packageJson = createRequire(import.meta.url).resolve(
        'electron-trio/package.json',
      )
      const bootstrap = path.join(
        path.dirname(packageJson),
        'dist/bootstrap.mjs',
      )
      const env = {
        ...process.env,
        ELECTRON_TRIO_RUNNER: JSON.stringify(config),
        VITE_DEV_SERVER_URL: config.rendererUrl,
      }
      delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE
      const child = spawn(binary, [bootstrap, ...(this.options.args ?? [])], {
        cwd: config.root,
        env,
        stdio:
          process.platform === 'linux'
            ? ['inherit', 'inherit', 'inherit', 'ignore', 'ipc']
            : ['inherit', 'inherit', 'inherit', 'ipc'],
      })
      this.child = child
      this.connect(child)
      child.once('exit', () => {
        if (this.child === child) this.child = undefined
      })
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
    })
    this.work = work.catch((error) => {
      this.logger.error(String(error))
    })
    return work
  }

  restart() {
    if (this.config && !this.closed)
      void this.start(this.config).catch(() => {})
  }
  reloadWindows() {
    if (this.child?.connected)
      this.child.send(
        { type: 'electron:reload' } satisfies ElectronProcessMessage,
        () => {},
      )
  }

  async close() {
    this.closed = true
    await this.work
    await this.stop()
  }

  private async stop() {
    const child = this.child
    this.child = undefined
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
      return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      if (child.connected)
        child.send(
          { type: 'electron:quit' } satisfies ElectronProcessMessage,
          (error) => {
            if (error) child.kill('SIGTERM')
          },
        )
      else child.kill('SIGTERM')
    })
  }
}
