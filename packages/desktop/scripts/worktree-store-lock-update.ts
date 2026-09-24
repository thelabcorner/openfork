#!/usr/bin/env bun
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

import {
  WORKTREE_STORE_LOCK_FILE,
  WORKTREE_STORE_LOCK_SCHEMA,
  WORKTREE_STORE_TARGETS,
  WorktreeStoreLockError,
  parseWorktreeStoreLock,
  readWorktreeStoreLock,
  resolveWorktreeStoreTarget,
  type WorktreeStoreLock,
  type WorktreeStorePin,
  type WorktreeStoreTarget,
} from "./worktree-store-lock"
import { WORKTREE_STORE_BUNDLE_MANIFEST_FILE, WorktreeStoreVerificationError, normalizeVersion, sha256Hex } from "./worktree-store-verify"
import {
  extractWorktreeStoreArchive,
  flattenWorktreeStorePayload,
  verifyWorktreeStoreArchivePayload,
  worktreeStoreArchiveFormat,
} from "./fetch-worktree-store"

const CLI_HELPER_ID = "refs-block-clone"
const SUPPORT_HELPER_ID = "storage-probe"

export interface WorktreeStoreLockUpdateInput {
  target: string
  url: string
  archivePath?: string
  version?: string
  manifest?: string
  cli?: string
  helper?: string
  lockPath?: string
  dryRun?: boolean
  log?: (message: string) => void
}

export interface WorktreeStoreLockUpdateResult {
  lock: WorktreeStoreLock
  pin: WorktreeStorePin
  path: string
  text: string
  written: boolean
  changes: string[]
}

function invalid(message: string): never {
  throw new WorktreeStoreLockError("invalid-input", message)
}

function requireField(name: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    invalid(`${name} is required; the lock updater never invents a release URL, version, or digest`)
  }
  return value
}

function httpsUrl(raw: string): string {
  let parsed: URL | undefined
  try {
    parsed = new URL(raw)
  } catch {
    parsed = undefined
  }
  if (parsed === undefined) invalid(`--url "${raw}" is not a valid URL`)
  if (parsed.protocol !== "https:") {
    invalid(`--url "${raw}" must use https:// so the lock never points at an unencrypted artifact`)
  }
  return raw
}

function commonVersion(targets: Record<WorktreeStoreTarget, WorktreeStorePin | null>): string | null {
  const versions = new Set<string>()
  for (const key of WORKTREE_STORE_TARGETS) {
    const pin = targets[key]
    if (pin) versions.add(pin.version)
  }
  if (versions.size !== 1) return null
  return [...versions][0] ?? null
}

async function readArtifactBytes(input: { url: string; archivePath?: string }): Promise<Uint8Array> {
  if (input.archivePath !== undefined) {
    const file = path.resolve(input.archivePath)
    try {
      return new Uint8Array(await readFile(file))
    } catch {
      return invalid(`--archive ${file} could not be read`)
    }
  }
  const response = await fetch(input.url, { headers: { "user-agent": "openfork-desktop-build" } })
  if (!response.ok) {
    throw new WorktreeStoreVerificationError("archive-download", `downloading ${input.url} failed with HTTP ${response.status}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

export async function updateWorktreeStoreLock(input: WorktreeStoreLockUpdateInput): Promise<WorktreeStoreLockUpdateResult> {
  const log = input.log ?? (() => {})
  const [platform, arch] = input.target.split("-")
  const target = resolveWorktreeStoreTarget(platform ?? "", arch ?? "")
  const url = httpsUrl(requireField("--url", input.url))
  const existing = await readWorktreeStoreLock(input.lockPath)
  const bytes = await readArtifactBytes({ url, archivePath: input.archivePath })
  const size = bytes.byteLength
  const sha256 = sha256Hex(bytes)

  const staging = await mkdtemp(path.join(tmpdir(), "openfork-worktree-store-lock-"))
  try {
    const sourceName = input.archivePath ?? new URL(url).pathname
    const format = worktreeStoreArchiveFormat(sourceName, "archive")
    const archiveFile = path.join(staging, format === "zip" ? "artifact.zip" : "artifact.tar.gz")
    await writeFile(archiveFile, bytes)
    const extracted = await mkdtemp(path.join(staging, "extract-"))
    const manifestPath = input.manifest ?? WORKTREE_STORE_BUNDLE_MANIFEST_FILE

    await extractWorktreeStoreArchive(archiveFile, extracted, format)
    await flattenWorktreeStorePayload(extracted)
    const { manifest } = await verifyWorktreeStoreArchivePayload(extracted, target, manifestPath)

    const declared = new Map(manifest.helpers.map((helper) => [helper.id, helper.relativePath]))
    const cli = input.cli ?? declared.get(CLI_HELPER_ID)
    if (cli === undefined) {
      invalid(`the bundle manifest declares no "${CLI_HELPER_ID}" helper; pass --cli with the archive-relative CLI path`)
    }
    if (!manifest.helpers.some((helper) => helper.relativePath === cli)) {
      invalid(`--cli "${cli}" is not declared by the bundle manifest`)
    }
    const helper = input.helper ?? declared.get(SUPPORT_HELPER_ID)
    if (helper !== undefined && !manifest.helpers.some((entry) => entry.relativePath === helper)) {
      invalid(`--helper "${helper}" is not declared by the bundle manifest`)
    }
    const manifestVersion = normalizeVersion(manifest.bundle.packageVersion)
    if (input.version !== undefined && normalizeVersion(input.version) !== manifestVersion) {
      invalid(`--version ${input.version} does not match the artifact bundle version ${manifestVersion}`)
    }
    const version = input.version === undefined ? manifestVersion : normalizeVersion(input.version)

    const pin: WorktreeStorePin = { version, archive: { url, size, sha256 }, manifest: manifestPath, cli }
    if (helper !== undefined) pin.helper = helper

    const targets: Record<WorktreeStoreTarget, WorktreeStorePin | null> = {
      "darwin-arm64": existing.lock.targets["darwin-arm64"],
      "darwin-x64": existing.lock.targets["darwin-x64"],
      "linux-arm64": existing.lock.targets["linux-arm64"],
      "linux-x64": existing.lock.targets["linux-x64"],
      "win32-arm64": existing.lock.targets["win32-arm64"],
      "win32-x64": existing.lock.targets["win32-x64"],
    }
    targets[target] = pin
    const lock = parseWorktreeStoreLock({
      schema: WORKTREE_STORE_LOCK_SCHEMA,
      version: commonVersion(targets),
      targets,
    })

    const text = `${JSON.stringify(lock, null, 2)}\n`
    const previous = existing.lock.targets[target]
    const changes = [
      `targets.${target}: ${previous ? `${previous.version} (sha256 ${previous.archive.sha256})` : "unpinned"} -> ${version} (sha256 ${sha256})`,
      `version: ${JSON.stringify(existing.lock.version)} -> ${JSON.stringify(lock.version)}`,
    ]
    if (!input.dryRun) {
      const temporary = `${existing.path}.${process.pid}.tmp`
      await writeFile(temporary, text, "utf8")
      await rename(temporary, existing.path)
    }
    log(`${input.dryRun ? "Would update" : "Updated"} ${existing.path}`)
    for (const change of changes) log(`  ${change}`)
    return { lock, pin, path: existing.path, text, written: input.dryRun !== true, changes }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      url: { type: "string" },
      archive: { type: "string" },
      version: { type: "string" },
      manifest: { type: "string" },
      cli: { type: "string" },
      helper: { type: "string" },
      lock: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  })
  if (values.help) {
    console.log(
      [
        "Pin a worktree-store release artifact into the checked-in lock.",
        "",
        "Usage:",
        "  bun ./scripts/worktree-store-lock-update.ts --target <os-arch> --url <https archive url> [options]",
        "",
        "Required:",
        "  --target   target key, one of " + WORKTREE_STORE_TARGETS.join(", "),
        "  --url      https URL the released artifact will be fetched from",
        "",
        "Options:",
        "  --archive  local copy of the artifact to read instead of downloading",
        "  --manifest archive-relative bundle manifest path (default " + WORKTREE_STORE_BUNDLE_MANIFEST_FILE + ")",
        "  --cli      archive-relative CLI path (default from the bundle manifest)",
        "  --helper   archive-relative helper path (default from the bundle manifest)",
        "  --version  must match the bundle manifest version when given",
        "  --lock     lock file path (default " + WORKTREE_STORE_LOCK_FILE + " next to the desktop package)",
        "  --dry-run  print the result without writing",
      ].join("\n"),
    )
  } else {
    const result = await updateWorktreeStoreLock({
      target: requireField("--target", values.target),
      url: requireField("--url", values.url),
      archivePath: values.archive,
      version: values.version,
      manifest: values.manifest,
      cli: values.cli,
      helper: values.helper,
      lockPath: values.lock,
      dryRun: values["dry-run"] === true,
    })
    console.log(`${result.written ? "Wrote" : "Dry run:"} ${result.path}`)
  }
}
