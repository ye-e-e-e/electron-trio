import { app } from "electron"
import { z } from "zod"
import { createIpcInvoke } from "electron-ipc-invoke"

export const getVersion = createIpcInvoke("desktop:getVersion")
	.inputValidator(z.object({ prefix: z.string() }))
	.handler(({ data }) => data.prefix +  app.getVersion())
