import fs from "node:fs/promises"
import path from "node:path"

export const USER_DATA_NAMES = {
  dev: "ai.openfork.desktop.dev",
  beta: "ai.openfork.desktop.beta",
  prod: "ai.openfork.desktop",
} as const

export const LEGACY_USER_DATA_NAMES = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
} as const

const IMPORT_MARKER = ".openfork-imported-opencode-v1"

function code(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

async function exists(target: string) {
  return fs.lstat(target).then(
    () => true,
    (error) => {
      if (code(error) === "ENOENT") return false
      throw error
    },
  )
}

async function copyMissing(source: string, destination: string): Promise<void> {
  if (!(await exists(source))) return
  if (!(await exists(destination))) {
    await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true })
    return
  }
  const [from, to] = await Promise.all([fs.lstat(source), fs.lstat(destination).catch(() => undefined)])
  if (!from.isDirectory() || !to?.isDirectory()) return
  await fs.mkdir(destination, { recursive: true })
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const legacy = path.join(source, entry.name)
    const current = path.join(destination, entry.name)
    if (!(await exists(current))) {
      await fs.cp(legacy, current, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true })
      continue
    }
    if (entry.isDirectory()) await copyMissing(legacy, current)
  }
}

export async function migrateLegacyUserData(appDataRoot: string, channel: keyof typeof USER_DATA_NAMES) {
  const legacy = path.join(appDataRoot, LEGACY_USER_DATA_NAMES[channel])
  const current = path.join(appDataRoot, USER_DATA_NAMES[channel])
  await fs.mkdir(current, { recursive: true })
  const marker = path.join(current, IMPORT_MARKER)
  if (!(await exists(marker))) {
    // Desktop state import is deliberately non-destructive so OpenFork can be
    // installed beside OpenCode without stealing or rewriting its profile.
    await copyMissing(legacy, current)
    await fs.writeFile(marker, `${new Date().toISOString()}\n`, { flag: "wx" }).catch((error) => {
      if (code(error) !== "EEXIST") throw error
    })
  }
  return current
}
