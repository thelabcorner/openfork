import { existsSync, renameSync, rmSync } from "node:fs"
import { parse } from "node:path"

export const DESKTOP_LOG_BACKUPS = 5

function backupPath(filePath: string, generation: number) {
  const info = parse(filePath)
  return `${info.dir}/${info.name}.${generation}${info.ext}`
}

/**
 * Keep a bounded generation history for electron-log's synchronous rotation.
 * The current file becomes .1, the previous .1 becomes .2, and so on.
 */
export function rotateLogHistory(filePath: string, keep = DESKTOP_LOG_BACKUPS) {
  if (keep <= 0) {
    rmSync(filePath, { force: true })
    return
  }

  rmSync(backupPath(filePath, keep), { force: true })
  for (let generation = keep - 1; generation >= 1; generation--) {
    const source = backupPath(filePath, generation)
    if (!existsSync(source)) continue
    renameSync(source, backupPath(filePath, generation + 1))
  }
  if (existsSync(filePath)) renameSync(filePath, backupPath(filePath, 1))
}