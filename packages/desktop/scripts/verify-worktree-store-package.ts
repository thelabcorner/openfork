import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

import {
  WORKTREE_STORE_CLI_ENV,
  WORKTREE_STORE_RESOURCE_DIRECTORY,
  WORKTREE_STORE_ROOT_ENV,
  resolveWorktreeStoreSidecarEnv,
} from "../src/main/worktree-store-env"
import { resolveChannel, type Channel } from "./utils"
import {
  WORKTREE_STORE_STAGE_FILE,
  WORKTREE_STORE_VERSION_FILE,
  defaultWorktreeStoreProbe,
  type WorktreeStoreProbe,
} from "./fetch-worktree-store"
import { readWorktreeStoreLock, resolveWorktreeStoreSource, resolveWorktreeStoreTarget } from "./worktree-store-lock"
import {
  WorktreeStoreVerificationError,
  assertPackagedStageStamp,
  normalizeVersion,
  parseVersionOutput,
  parseWorktreeStoreBundleManifest,
  parseWorktreeStoreStageStamp,
  verifyExtractedTree,
  verifyWorktreeStoreBundleTarget,
  verifyWorktreeStoreCliDiscoverable,
  verifyWorktreeStoreStageStamp,
} from "./worktree-store-verify"

export interface VerifyPackagedWorktreeStoreOptions {
  channel?: Channel
  lockPath?: string
  probe?: WorktreeStoreProbe
  env?: Record<string, string | undefined>
}

async function find(root: string, target: string, depth = 0): Promise<string[]> {
  if (depth > 8 || !existsSync(root)) return []
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isFile() && entry.name === target) result.push(full)
    else if (entry.isDirectory()) result.push(...(await find(full, target, depth + 1)))
  }
  return result
}

export async function verifyPackagedWorktreeStore(
  dist: string,
  options: VerifyPackagedWorktreeStoreOptions = {},
): Promise<void> {
  const channel = options.channel ?? resolveChannel()
  const probe = options.probe ?? defaultWorktreeStoreProbe
  const env = options.env ?? process.env
  const { lock, digest } = await readWorktreeStoreLock(options.lockPath)
  const targetKey = resolveWorktreeStoreTarget(process.platform, process.arch)
  const source = resolveWorktreeStoreSource({ lock, target: targetKey, channel, env })
  const stamps = await find(dist, WORKTREE_STORE_STAGE_FILE)

  if (source.kind !== "pinned") {
    if (stamps.length > 0) {
      throw new Error(
        `Packaged worktree-store payload found at ${path.relative(dist, stamps[0]!)} but the checked-in lock pins no ${targetKey} target`,
      )
    }
    console.log(`No pinned worktree-store sidecar; packaged artifact verified without a managed payload (channel=${channel})`)
    return
  }

  if (stamps.length !== 1) {
    throw new Error(`Expected exactly one packaged worktree-store ${WORKTREE_STORE_STAGE_FILE} under ${dist}; found ${stamps.length}`)
  }
  const stageFile = stamps[0]!
  const dir = path.dirname(stageFile)
  if (dir.split(path.sep).includes("app.asar.unpacked")) {
    throw new Error(`Packaged worktree-store payload must live outside app.asar; found ${path.relative(dist, dir)}`)
  }
  if (path.basename(dir) !== WORKTREE_STORE_RESOURCE_DIRECTORY) {
    throw new WorktreeStoreVerificationError(
      "layout-mismatch",
      `Packaged worktree-store payload directory must be named "${WORKTREE_STORE_RESOURCE_DIRECTORY}"; found "${path.basename(dir)}"`,
    )
  }
  verifyWorktreeStoreCliDiscoverable(source.pin.cli, targetKey, "packaged worktree-store")
  if (targetKey.startsWith("win32-")) {
    const expectedCli = path.join(dir, ...source.pin.cli.split("/"))
    const discovered = resolveWorktreeStoreSidecarEnv({
      resourcesPath: path.dirname(dir),
      platform: "win32",
      env: {},
      exists: existsSync,
    })
    if (discovered[WORKTREE_STORE_ROOT_ENV] !== dir || discovered[WORKTREE_STORE_CLI_ENV] !== expectedCli) {
      throw new WorktreeStoreVerificationError(
        "layout-mismatch",
        `Packaged worktree-store payload is not discoverable by the desktop runtime: the runtime publishes ${JSON.stringify(discovered)} instead of root ${dir} and cli ${expectedCli}`,
      )
    }
  }

  const stamp = parseWorktreeStoreStageStamp(
    JSON.parse(await readFile(stageFile, "utf8")),
    "packaged worktree-store STAGE.json",
  )
  assertPackagedStageStamp(stamp, "packaged worktree-store")
  verifyWorktreeStoreStageStamp(
    stamp,
    {
      lockDigest: digest,
      targetKey,
      version: source.pin.version,
      archiveSha256: source.pin.archive.sha256,
      archiveSize: source.pin.archive.size,
    },
    "packaged worktree-store",
  )

  const versionFile = path.join(dir, WORKTREE_STORE_VERSION_FILE)
  if (!existsSync(versionFile)) {
    throw new Error(`Packaged worktree-store payload is missing ${WORKTREE_STORE_VERSION_FILE}`)
  }
  const versionText = (await readFile(versionFile, "utf8")).trim()
  if (versionText !== stamp.version) {
    throw new Error(`Packaged worktree-store ${WORKTREE_STORE_VERSION_FILE} is ${versionText}; expected ${stamp.version}`)
  }

  for (const name of source.pin.helper === undefined ? [source.pin.cli] : [source.pin.cli, source.pin.helper]) {
    const executable = path.join(dir, ...name.split("/"))
    if (!existsSync(executable)) {
      throw new Error(`Packaged worktree-store payload is missing the pinned executable ${name}`)
    }
    const result = probe(executable, ["--version"])
    if (result.error) throw result.error
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    if (result.status !== 0) {
      throw new Error(`Packaged worktree-store ${name} --version exited with ${result.status}: ${output.trim()}`)
    }
    const observed = parseVersionOutput(output, `packaged worktree-store ${name} --version`)
    if (observed !== normalizeVersion(source.pin.version)) {
      throw new Error(`Packaged worktree-store ${name} reported ${observed}; expected ${source.pin.version}`)
    }
  }

  const manifestFile = path.join(dir, ...source.pin.manifest.split("/"))
  if (existsSync(manifestFile)) {
    let rawManifest: unknown
    try {
      rawManifest = JSON.parse(await readFile(manifestFile, "utf8"))
    } catch (error) {
      throw new WorktreeStoreVerificationError(
        "manifest-invalid",
        `packaged worktree-store manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const manifest = parseWorktreeStoreBundleManifest(rawManifest, "packaged worktree-store manifest")
    verifyWorktreeStoreBundleTarget(manifest, targetKey, "packaged worktree-store")
    await verifyExtractedTree(dir, manifest, source.pin.manifest, "packaged worktree-store", {
      allowUndeclared: [WORKTREE_STORE_VERSION_FILE, WORKTREE_STORE_STAGE_FILE],
    })
  }

  console.log(`Packaged worktree-store ${stamp.version} verified at ${path.relative(dist, dir)}`)
}

if (import.meta.main) {
  const dist = path.resolve(process.argv[2] ?? "dist")
  await verifyPackagedWorktreeStore(dist)
}
