import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { $ } from "bun"

import { resolveChannel, type Channel } from "./utils"
import {
  WORKTREE_STORE_BUNDLE_MANIFEST_FILE,
  WORKTREE_STORE_PRESERVED_FILES,
  WorktreeStoreVerificationError,
  assertSafeArchiveEntries,
  assertSafeArchiveEntry,
  assertSafeRelativePath,
  digestOfFile,
  mappedExecutableReusable,
  normalizeVersion,
  parseVersionOutput,
  parseWorktreeStoreBundleManifest,
  sha256Hex,
  verifyArchiveBytes,
  verifyExtractedTree,
  verifyHandshake,
  verifyWorktreeStoreBundleTarget,
  verifyWorktreeStoreCliDiscoverable,
  type WorktreeStoreBundleManifest,
  type WorktreeStoreStageStamp,
} from "./worktree-store-verify"
import {
  WorktreeStoreLockError,
  readWorktreeStoreLock,
  resolveWorktreeStoreSource,
  resolveWorktreeStoreTarget,
  type LoadedWorktreeStoreLock,
  type WorktreeStorePin,
  type WorktreeStoreSource,
  type WorktreeStoreTarget,
} from "./worktree-store-lock"

export const WORKTREE_STORE_VERSION_FILE = "VERSION"
export const WORKTREE_STORE_STAGE_FILE = "STAGE.json"

export interface WorktreeStoreProbeResult {
  status: number | null
  stdout?: string | null
  stderr?: string | null
  error?: Error
}

export type WorktreeStoreProbe = (executable: string, args: readonly string[]) => WorktreeStoreProbeResult

export const defaultWorktreeStoreProbe: WorktreeStoreProbe = (executable, args) =>
  spawnSync(executable, [...args], { encoding: "utf8", windowsHide: true, timeout: 15_000 })

export interface StageWorktreeStoreOptions {
  packageDir?: string
  lockPath?: string
  platform?: string
  arch?: string
  channel?: Channel
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  probe?: WorktreeStoreProbe
  log?: (message: string) => void
}

export interface StageWorktreeStoreResult {
  staged: boolean
  targetKey: string
  source?: "pinned" | "dev-local"
  reason?: string
}

export function worktreeStoreOutputDir(packageDir: string): string {
  return path.join(packageDir, "resources", "worktree-store")
}

function executableNames(pin: WorktreeStorePin): string[] {
  return pin.helper === undefined ? [pin.cli] : [pin.cli, pin.helper]
}

function payloadPath(root: string, relative: string): string {
  return path.join(root, ...relative.split("/"))
}

export function worktreeStoreArchiveFormat(url: string, where: string): "zip" | "tar.gz" {
  let pathname: string
  try {
    pathname = new URL(url).pathname.toLowerCase()
  } catch {
    throw new WorktreeStoreVerificationError("archive-format", `${where}: "${url}" is not a valid archive URL`)
  }
  if (pathname.endsWith(".zip")) return "zip"
  if (pathname.endsWith(".tar.gz") || pathname.endsWith(".tgz")) return "tar.gz"
  throw new WorktreeStoreVerificationError(
    "archive-format",
    `${where}: pinned archive URL must end in .zip, .tar.gz, or .tgz`,
  )
}

function mappedExecutableError(error: unknown, platform: string): Error {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : ""
  if (platform === "win32" && (code === "EACCES" || code === "EPERM")) {
    return new WorktreeStoreVerificationError(
      "mapped-executable",
      "Cannot replace the pinned worktree-store runtime while the existing Windows runtime is in use. Stop the running OpenFork desktop and retry the build.",
    )
  }
  return error instanceof Error ? error : new Error(String(error))
}

async function listArchiveEntries(archive: string, format: "zip" | "tar.gz"): Promise<string[]> {
  const lines = (output: string) =>
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  if (process.platform === "win32") return lines(await $`tar.exe -tf ${archive}`.text())
  if (format === "tar.gz") return lines(await $`tar -tzf ${archive}`.text())
  return lines(await $`unzip -Z1 ${archive}`.text())
}

export async function extractWorktreeStoreArchive(archive: string, directory: string, format: "zip" | "tar.gz"): Promise<void> {
  assertSafeArchiveEntries(await listArchiveEntries(archive, format), path.basename(archive))
  if (process.platform === "win32") await $`tar.exe -xf ${archive} -C ${directory}`
  else if (format === "tar.gz") await $`tar -xzf ${archive} -C ${directory}`
  else await $`unzip -q -o ${archive} -d ${directory}`
}

export async function flattenWorktreeStorePayload(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.length !== 1 || !entries[0]!.isDirectory()) return
  const nested = path.join(directory, entries[0]!.name)
  const { rename } = await import("node:fs/promises")
  for (const name of await readdir(nested)) {
    await rename(path.join(nested, name), path.join(directory, name))
  }
  await rm(nested, { recursive: true, force: true })
}

export async function readWorktreeStorePayloadManifest(root: string, manifestPath: string, where: string) {
  const safe = assertSafeRelativePath(manifestPath, `${where}.manifest`)
  const file = payloadPath(root, safe)
  if (!existsSync(file)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    throw new WorktreeStoreVerificationError(
      "manifest-invalid",
      `${where}: ${safe} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { manifest: parseWorktreeStoreBundleManifest(raw, `${where}.${safe}`), manifestPath: safe }
}

export async function verifyWorktreeStoreArchivePayload(
  root: string,
  targetKey: string,
  manifestPath: string,
): Promise<{ manifest: WorktreeStoreBundleManifest; manifestPath: string }> {
  const where = `${targetKey} payload`
  rejectPreservedFiles(root, where)
  const parsed = await readWorktreeStorePayloadManifest(root, manifestPath, where)
  if (!parsed) {
    throw new WorktreeStoreVerificationError(
      "manifest-missing",
      `staged ${targetKey} payload is missing its pinned manifest ${manifestPath}`,
    )
  }
  verifyWorktreeStoreBundleTarget(parsed.manifest, targetKey, where)
  await verifyExtractedTree(root, parsed.manifest, parsed.manifestPath, where)
  return parsed
}

function rejectPreservedFiles(root: string, where: string): void {
  for (const name of WORKTREE_STORE_PRESERVED_FILES) {
    if (existsSync(path.join(root, name))) {
      throw new WorktreeStoreVerificationError(
        "preserved-file",
        `${where}: staged payload must not contain the repository-owned file ${name}`,
      )
    }
  }
}

async function emptyDirectoryExcept(directory: string, preserve: readonly string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (preserve.includes(entry.name)) continue
    await rm(path.join(directory, entry.name), { recursive: true, force: true })
  }
}

async function syncSupportFiles(staging: string, output: string, skip: ReadonlySet<string>): Promise<void> {
  await mkdir(output, { recursive: true })
  for (const entry of await readdir(staging)) {
    if (skip.has(entry)) continue
    await cp(path.join(staging, entry), path.join(output, entry), { recursive: true, force: true })
  }
}

async function installStagedRoot(
  stagedRoot: string,
  output: string,
  options: { platform: string; executables: readonly string[]; log: (message: string) => void },
): Promise<void> {
  await mkdir(output, { recursive: true })
  const stagedDigests = new Map<string, string>()
  for (const name of options.executables) {
    const digest = await digestOfFile(payloadPath(stagedRoot, name))
    if (digest === undefined) {
      throw new WorktreeStoreVerificationError(
        "executable-missing",
        `staged worktree-store payload does not contain the pinned executable ${name}`,
      )
    }
    stagedDigests.set(name, digest)
  }

  let reuse = options.platform === "win32" && options.executables.length > 0
  for (const name of options.executables) {
    const installed = await digestOfFile(payloadPath(output, name))
    if (!mappedExecutableReusable(options.platform, installed, stagedDigests.get(name)!)) {
      reuse = false
      break
    }
  }

  if (reuse) {
    // A running Windows desktop keeps the installed executable mapped and
    // prevents removing its parent directory. If the installed executable is
    // byte-identical to the checksum-verified staged executable, preserve that
    // mapped file and refresh only the support payload.
    options.log("Preserving the mapped worktree-store executable and refreshing support files")
    try {
      await syncSupportFiles(stagedRoot, output, new Set(options.executables.map((name) => name.split("/")[0]!)))
    } catch (error) {
      throw mappedExecutableError(error, options.platform)
    }
    return
  }

  try {
    await emptyDirectoryExcept(output, WORKTREE_STORE_PRESERVED_FILES)
    await cp(stagedRoot, output, { recursive: true, force: true })
  } catch (error) {
    throw mappedExecutableError(error, options.platform)
  }
}

async function writeStamps(packageDir: string, stamp: WorktreeStoreStageStamp): Promise<void> {
  const output = worktreeStoreOutputDir(packageDir)
  await mkdir(output, { recursive: true })
  await writeFile(path.join(output, WORKTREE_STORE_VERSION_FILE), `${stamp.version}\n`, "utf8")
  await writeFile(path.join(output, WORKTREE_STORE_STAGE_FILE), `${JSON.stringify(stamp, null, 2)}\n`, "utf8")
}

async function chmodExecutables(packageDir: string, pin: WorktreeStorePin, platform: string): Promise<void> {
  if (platform === "win32") return
  const output = worktreeStoreOutputDir(packageDir)
  for (const name of executableNames(pin)) {
    const file = payloadPath(output, name)
    if (existsSync(file)) await chmod(file, 0o755)
  }
}

async function probeInstalledHandshake(
  packageDir: string,
  pin: WorktreeStorePin,
  targetKey: string,
  probe: WorktreeStoreProbe,
): Promise<void> {
  const output = worktreeStoreOutputDir(packageDir)
  const observed: { cli?: string; helper?: string } = {}
  for (const [channel, name] of [
    ["cli", pin.cli],
    ["helper", pin.helper],
  ] as const) {
    if (name === undefined) continue
    const executable = payloadPath(output, name)
    const result = probe(executable, ["--version"])
    if (result.error) throw result.error
    const text = `${result.stdout ?? ""}${result.stderr ?? ""}`
    if (result.status !== 0) {
      throw new WorktreeStoreVerificationError(
        "handshake-output",
        `worktree-store ${channel} --version exited with ${result.status}: ${text.trim()}`,
      )
    }
    observed[channel] = parseVersionOutput(text, `worktree-store ${channel} --version`)
  }
  const expectedVersion = normalizeVersion(pin.version)
  verifyHandshake(
    pin.helper === undefined ? { cli: expectedVersion } : { cli: expectedVersion, helper: expectedVersion },
    observed,
    `${targetKey} handshake`,
  )
}

async function stagePinned(input: {
  packageDir: string
  platform: string
  targetKey: string
  pin: WorktreeStorePin
  lockDigest: string
  fetchImpl: typeof fetch
  probe: WorktreeStoreProbe
  log: (message: string) => void
}): Promise<void> {
  const { packageDir, platform, targetKey, pin, log } = input
  verifyWorktreeStoreCliDiscoverable(pin.cli, targetKey, `targets.${targetKey}.cli`)
  const archiveName = assertSafeArchiveEntry(
    path.posix.basename(new URL(pin.archive.url).pathname),
    `targets.${targetKey}.archive.url`,
  )
  const format = worktreeStoreArchiveFormat(pin.archive.url, `targets.${targetKey}.archive.url`)
  const cacheDir = path.join(packageDir, "node_modules", ".cache", "openfork-worktree-store")
  const cacheFile = path.join(cacheDir, archiveName)
  await mkdir(cacheDir, { recursive: true })
  if (!existsSync(cacheFile)) {
    const response = await input.fetchImpl(pin.archive.url, {
      headers: { "user-agent": "openfork-desktop-build" },
    })
    if (!response.ok) {
      throw new WorktreeStoreVerificationError(
        "archive-download",
        `downloading ${archiveName} failed with HTTP ${response.status}`,
      )
    }
    await writeFile(cacheFile, Buffer.from(await response.arrayBuffer()))
  }

  const bytes = await readFile(cacheFile)
  try {
    verifyArchiveBytes(bytes, pin.archive, archiveName)
  } catch (error) {
    await rm(cacheFile, { force: true })
    throw error
  }

  const staging = await mkdtemp(path.join(tmpdir(), "openfork-worktree-store-"))
  try {
    await extractWorktreeStoreArchive(cacheFile, staging, format)
    await flattenWorktreeStorePayload(staging)
    await verifyWorktreeStoreArchivePayload(staging, targetKey, pin.manifest)
    await installStagedRoot(staging, worktreeStoreOutputDir(packageDir), {
      platform,
      executables: executableNames(pin),
      log,
    })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }

  await chmodExecutables(packageDir, pin, platform)
  await probeInstalledHandshake(packageDir, pin, targetKey, input.probe)
  await writeStamps(packageDir, {
    schemaVersion: 1,
    source: "pinned",
    targetKey,
    version: pin.version,
    lockDigest: input.lockDigest,
    archiveSha256: pin.archive.sha256,
    archiveSize: pin.archive.size,
  })
  log(`Pinned worktree-store ${pin.version} staged for ${targetKey}`)
}

async function stageDevLocal(input: {
  packageDir: string
  platform: string
  targetKey: string
  lockDigest: string
  localArchive: string
  log: (message: string) => void
}): Promise<void> {
  const { packageDir, platform, targetKey, log } = input
  const source = path.resolve(input.localArchive)
  let info
  try {
    info = await stat(source)
  } catch {
    throw new WorktreeStoreLockError(
      "dev-override-rejected",
      `development-only worktree-store local archive ${source} does not exist`,
    )
  }

  const staging = await mkdtemp(path.join(tmpdir(), "openfork-worktree-store-dev-"))
  try {
    let root = staging
    if (info.isDirectory()) {
      root = path.join(staging, "payload")
      await cp(source, root, { recursive: true, force: true })
    } else if (info.isFile()) {
      const lower = source.toLowerCase()
      const format = lower.endsWith(".zip") ? "zip" : lower.endsWith(".tar.gz") || lower.endsWith(".tgz") ? "tar.gz" : undefined
      if (!format) {
        throw new WorktreeStoreLockError(
          "dev-override-rejected",
          "development-only worktree-store local archive must be a directory, a .zip file, or a .tar.gz file",
        )
      }
      await extractWorktreeStoreArchive(source, staging, format)
      await flattenWorktreeStorePayload(staging)
    } else {
      throw new WorktreeStoreLockError(
        "dev-override-rejected",
        `development-only worktree-store local archive ${source} is neither a file nor a directory`,
      )
    }

    rejectPreservedFiles(root, "dev-local payload")
    const parsed = await readWorktreeStorePayloadManifest(root, WORKTREE_STORE_BUNDLE_MANIFEST_FILE, "dev-local payload")
    if (parsed) await verifyExtractedTree(root, parsed.manifest, parsed.manifestPath, "dev-local payload")
    else log(`dev-local worktree-store payload has no ${WORKTREE_STORE_BUNDLE_MANIFEST_FILE}; internal digest verification is skipped`)

    await installStagedRoot(root, worktreeStoreOutputDir(packageDir), { platform, executables: [], log })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }

  await writeStamps(packageDir, {
    schemaVersion: 1,
    source: "dev-local",
    targetKey,
    version: "dev-local",
    lockDigest: input.lockDigest,
    archiveSha256: info.isFile() ? sha256Hex(await readFile(source)) : null,
    archiveSize: info.isFile() ? info.size : null,
  })
  log(`Development-only worktree-store payload staged for ${targetKey}; it must never be packaged or released`)
}

export interface WorktreeStorePreflightOptions {
  lockPath?: string
  platform?: string
  arch?: string
  channel?: Channel
  env?: Record<string, string | undefined>
}

export interface WorktreeStorePreflightResult {
  channel: Channel
  targetKey: WorktreeStoreTarget
  source: WorktreeStoreSource
  lock: LoadedWorktreeStoreLock
}

export async function preflightWorktreeStore(
  options: WorktreeStorePreflightOptions = {},
): Promise<WorktreeStorePreflightResult> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const channel = options.channel ?? resolveChannel()
  const env = options.env ?? process.env
  const targetKey = resolveWorktreeStoreTarget(platform, arch)
  const lock = await readWorktreeStoreLock(options.lockPath)
  const source = resolveWorktreeStoreSource({ lock: lock.lock, target: targetKey, channel, env })
  if (source.kind === "local" && !existsSync(source.path)) {
    throw new WorktreeStoreLockError(
      "dev-override-rejected",
      `development-only worktree-store local archive ${path.resolve(source.path)} does not exist`,
    )
  }
  return { channel, targetKey, source, lock }
}

export async function stageWorktreeStore(options: StageWorktreeStoreOptions = {}): Promise<StageWorktreeStoreResult> {
  const packageDir = options.packageDir ?? path.resolve(import.meta.dir, "..")
  const platform = options.platform ?? process.platform
  const log = options.log ?? console.log
  const { channel, targetKey, source, lock } = await preflightWorktreeStore(options)
  const digest = lock.digest

  if (source.kind === "pinned") {
    await stagePinned({
      packageDir,
      platform,
      targetKey,
      pin: source.pin,
      lockDigest: digest,
      fetchImpl: options.fetchImpl ?? fetch,
      probe: options.probe ?? defaultWorktreeStoreProbe,
      log,
    })
    return { staged: true, targetKey, source: "pinned" }
  }

  if (source.kind === "local") {
    await stageDevLocal({ packageDir, platform, targetKey, lockDigest: digest, localArchive: source.path, log })
    return { staged: true, targetKey, source: "dev-local" }
  }

  const output = worktreeStoreOutputDir(packageDir)
  if (existsSync(path.join(output, WORKTREE_STORE_STAGE_FILE))) {
    log("Removing a stale worktree-store payload from a previous staging run")
    try {
      await rm(output, { recursive: true, force: true })
    } catch (error) {
      throw mappedExecutableError(error, platform)
    }
  }
  await mkdir(output, { recursive: true })
  const reason = `no worktree-store target pinned for ${targetKey} (channel=${channel}); packaging continues without the managed sidecar`
  log(`worktree-store sidecar skipped: ${reason}`)
  return { staged: false, targetKey, reason }
}

if (import.meta.main) {
  await stageWorktreeStore()
}
