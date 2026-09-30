import { app } from 'electron'
import { createIpcInvoke } from 'electron-start'
import { z } from 'zod'

export const getVersion = createIpcInvoke('desktop:getVersion')
  .inputValidator(z.object({ prefix: z.string() }))
  .handler(({ data }) => data.prefix + app.getVersion())
