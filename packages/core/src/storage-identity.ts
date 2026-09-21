import fs from "node:fs/promises"
import path from "node:path"
import { PRODUCT_SLUG } from "./brand"

/**
 * Canonical fork-owned filesystem identity.
 *
 * `opencode` remains valid where it is an explicit compatibility identifier
 * (executable name, provider ID, env var, remote service contract, etc.). Local
 * persistence is not such a boundary: OpenFork owns it and writes under its own
 * namespace. The legacy name exists here only as a one-way migration source.
 */
export const STORAGE_NAMESPACE = PRODUCT_SLUG
export const LEGACY_STORAGE_NAMESPACE = "opencode"
export const CONFIG_BASENAME = STORAGE_NAMESPACE
export const LEGACY_CONFIG_BASENAME = LEGACY_STORAGE_NAMESPACE
export const PROJECT_CONFIG_DIRNAME = `.${STORAGE_NAMESPACE}`
export const LEGACY_PROJECT_CONFIG_DIRNAME = `.${LEGACY_STORAGE_NAMESPACE}`
export const DIRECT_INSTALL_DIRNAME = PROJECT_CONFIG_DIRNAME
export const LEGACY_DIRECT_INSTALL_DIRNAME = LEGACY_PROJECT_CONFIG_DIRNAME
export const DATABASE_BASENAME = `${STORAGE_NAMESPACE}.db`
export const LEGACY_DATABASE_BASENAME = `${LEGACY_STORAGE_NAMESPACE}.db`
export const RUNTIME_LOCK_DIRNAME = `.${STORAGE_NAMESPACE}-runtime-locks`
export const SKILL_VERSION_FILENAME = `.${STORAGE_NAMESPACE}-version`
export const LEGACY_SKILL_VERSION_FILENAME = `.${LEGACY_STORAGE_NAMESPACE}-version`
export const LEGACY_IMPORT_MARKER_FILENAME = `.${STORAGE_NAMESPACE}-imported-${LEGACY_STORAGE_NAMESPACE}-v1`

export const CONFIG_BASENAMES = [LEGACY_CONFIG_BASENAME, CONFIG_BASENAME] as const
export const PROJECT_CONFIG_DIRNAMES = [LEGACY_PROJECT_CONFIG_DIRNAME, PROJECT_CONFIG_DIRNAME] as const

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

async function move(source: string, destination: string) {
  try {
    await fs.rename(source, destination)
    return true
  } catch (error) {
    if (code(error) !== "EXDEV") return false
  }
  try {
    await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true })
    await fs.rm(source, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

async function copyMissing(source: string, destination: string): Promise<void> {
  if (!(await exists(source))) return
  if (!(await exists(destination))) {
    await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true })
    return
  }

  const [sourceInfo, destinationInfo] = await Promise.all([fs.lstat(source), fs.lstat(destination).catch(() => undefined)])
  if (!sourceInfo.isDirectory() || !destinationInfo?.isDirectory()) return

  await fs.mkdir(destination, { recursive: true })
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (!(await exists(to))) {
      await fs.cp(from, to, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true })
      continue
    }
    if (entry.isDirectory()) await copyMissing(from, to)
  }
}

export async function migrateLegacyStorageDirectory(legacy: string, current: string) {
  if (path.resolve(legacy) === path.resolve(current)) return
  await fs.mkdir(current, { recursive: true })
  const marker = path.join(current, LEGACY_IMPORT_MARKER_FILENAME)
  if (await exists(marker)) return
  // Import rather than move: OpenFork may coexist with an upstream OpenCode
  // installation, so migration must never destroy another product's state.
  await copyMissing(legacy, current)
  await fs.writeFile(marker, `${new Date().toISOString()}\n`, { flag: "wx" }).catch((error) => {
    if (code(error) !== "EEXIST") throw error
  })
}

export function migratedDatabaseFilename(filename: string) {
  const marker = filename.indexOf(".db")
  if (marker === -1) return undefined
  const stem = filename.slice(0, marker)
  if (stem !== LEGACY_STORAGE_NAMESPACE && !stem.startsWith(`${LEGACY_STORAGE_NAMESPACE}-`)) return undefined
  return STORAGE_NAMESPACE + filename.slice(LEGACY_STORAGE_NAMESPACE.length)
}

export async function migrateLegacyDatabaseNames(dataDirectory: string) {
  const entries = await fs.readdir(dataDirectory).catch((error) => {
    if (code(error) === "ENOENT") return [] as string[]
    throw error
  })
  for (const filename of entries) {
    const migrated = migratedDatabaseFilename(filename)
    if (!migrated || migrated === filename) continue
    const source = path.join(dataDirectory, filename)
    const destination = path.join(dataDirectory, migrated)
    if (await exists(destination)) continue
    await move(source, destination)
  }
}

export async function migrateLegacyNamedFile(source: string, destination: string) {
  if (!(await exists(source)) || (await exists(destination))) return
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await move(source, destination)
}

export function productStoragePath(parent: string) {
  return path.join(parent, STORAGE_NAMESPACE)
}

export function legacyStoragePath(parent: string) {
  return path.join(parent, LEGACY_STORAGE_NAMESPACE)
}
