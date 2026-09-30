/** IPC definitions are identified by source file, independently of Vite queries. */
export function ipcDefinitionId(id: string): string {
  return id.split('?', 1)[0]
}
