import { readFile } from "node:fs/promises"
import path from "node:path"

import type { Channel } from "./utils"
import { assertSafeRelativePath, sha256Hex } from "./worktree-store-verify"

export const WORKTREE_STORE_LOCK_SCHEMA = "openfork.worktree-store.lock/v1"
export const WORKTREE_STORE_LOCK_FILE = "worktree-store.lock.json"
export const WORKTREE_STORE_DEV_ARCHIVE_ENV = "OPENFORK_WORKTREE_STORE_DEV_ARCHIVE"

export const WORKTREE_STORE_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
] as const

export type WorktreeStoreTarget = (typeof WORKTREE_STORE_TARGETS)[number]

export interface WorktreeStoreArchivePin {
  url: string
  size: number
  sha256: string
}

export interface WorktreeStorePin {
  version: string
  archive: WorktreeStoreArchivePin
  manifest: string
  cli: string
  helper?: string
}

export interface WorktreeStoreLock {
  schema: typeof WORKTREE_STORE_LOCK_SCHEMA
  version: string | null
  targets: Record<WorktreeStoreTarget, WorktreeStorePin | null>
}

export class WorktreeStoreLockError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "WorktreeStoreLockError"
  }
}

function fail(code: string, message: string): never {
  throw new WorktreeStoreLockError(code, message)
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

function expectObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("invalid-field", `${where} must be an object`)
  }
  return value as Record<string, unknown>
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail("unknown-field", `${where} contains unknown field "${key}"; expected one of ${allowed.join(", ")}`)
    }
  }
}

function expectString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key]
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid-field", `${where}.${key} must be a non-empty string`)
  }
  return value
}

function expectVersion(record: Record<string, unknown>, key: string, where: string): string {
  const value = expectString(record, key, where)
  if (!VERSION_PATTERN.test(value)) {
    fail("invalid-field", `${where}.${key} "${value}" is not a pinned semver version`)
  }
  return value
}

function expectSafePath(record: Record<string, unknown>, key: string, where: string): string {
  const value = expectString(record, key, where)
  try {
    return assertSafeRelativePath(value, `${where}.${key}`)
  } catch (error) {
    fail("invalid-field", `${where}.${key}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseArchive(raw: unknown, where: string): WorktreeStoreArchivePin {
  const record = expectObject(raw, where)
  rejectUnknownKeys(record, ["url", "size", "sha256"], where)
  const url = expectString(record, "url", where)
  if (!url.startsWith("https://")) {
    fail("invalid-field", `${where}.url must be an https:// URL; never stage a worktree-store archive without a verified pin`)
  }
  const size = record.size
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
    fail("invalid-field", `${where}.size must be a positive integer`)
  }
  const sha256 = expectString(record, "sha256", where)
  if (!SHA256_PATTERN.test(sha256)) {
    fail("invalid-field", `${where}.sha256 must be a lowercase sha256 hex digest`)
  }
  return { url, size, sha256 }
}

function parsePin(raw: unknown, where: string): WorktreeStorePin {
  const record = expectObject(raw, where)
  rejectUnknownKeys(record, ["version", "archive", "manifest", "cli", "helper"], where)
  const version = expectVersion(record, "version", where)
  const archive = parseArchive(record.archive, `${where}.archive`)
  const manifest = expectSafePath(record, "manifest", where)
  const cli = expectSafePath(record, "cli", where)
  const pin: WorktreeStorePin = { version, archive, manifest, cli }
  if (record.helper !== undefined) pin.helper = expectSafePath(record, "helper", where)
  return pin
}

export function parseWorktreeStoreLock(raw: unknown): WorktreeStoreLock {
  const record = expectObject(raw, "worktree-store lock")
  rejectUnknownKeys(record, ["schema", "version", "targets"], "worktree-store lock")
  if (record.schema !== WORKTREE_STORE_LOCK_SCHEMA) {
    fail("unsupported-schema", `worktree-store lock schema must be "${WORKTREE_STORE_LOCK_SCHEMA}"`)
  }
  if (!Object.hasOwn(record, "version")) {
    fail("invalid-field", "worktree-store lock.version must be present (null while no release target is pinned)")
  }
  const version = record.version === null ? null : expectVersion(record, "version", "worktree-store lock")

  const targetsRecord = expectObject(record.targets, "worktree-store lock.targets")
  for (const key of WORKTREE_STORE_TARGETS) {
    if (!Object.hasOwn(targetsRecord, key)) {
      fail("missing-target", `worktree-store lock.targets must list every supported target; "${key}" is missing`)
    }
  }
  rejectUnknownKeys(targetsRecord, WORKTREE_STORE_TARGETS, "worktree-store lock.targets")

  const targets = {} as Record<WorktreeStoreTarget, WorktreeStorePin | null>
  for (const key of WORKTREE_STORE_TARGETS) {
    const value = targetsRecord[key]
    targets[key] = value === null ? null : parsePin(value, `worktree-store lock.targets.${key}`)
  }
  return { schema: WORKTREE_STORE_LOCK_SCHEMA, version, targets }
}

export function worktreeStoreLockPath(packageDir: string): string {
  return path.join(packageDir, WORKTREE_STORE_LOCK_FILE)
}

export interface LoadedWorktreeStoreLock {
  lock: WorktreeStoreLock
  text: string
  digest: string
  path: string
}

export async function readWorktreeStoreLock(lockPath?: string): Promise<LoadedWorktreeStoreLock> {
  const file = lockPath ?? path.resolve(import.meta.dir, "..", WORKTREE_STORE_LOCK_FILE)
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : ""
    if (code === "ENOENT") {
      fail("lock-missing", `worktree-store lock not found at ${file}; the managed sidecar cannot be staged without a checked-in lock`)
    }
    throw error
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    fail("invalid-json", `worktree-store lock is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { lock: parseWorktreeStoreLock(raw), text, digest: sha256Hex(text), path: file }
}

export async function loadWorktreeStoreLock(lockPath?: string): Promise<WorktreeStoreLock> {
  return (await readWorktreeStoreLock(lockPath)).lock
}

export function resolveWorktreeStoreTarget(platform: string, arch: string): WorktreeStoreTarget {
  const key = `${platform}-${arch}`
  if (!(WORKTREE_STORE_TARGETS as readonly string[]).includes(key)) {
    fail(
      "missing-target",
      `platform "${platform}" arch "${arch}" is not a supported worktree-store target; supported targets: ${WORKTREE_STORE_TARGETS.join(", ")}`,
    )
  }
  return key as WorktreeStoreTarget
}

export interface WorktreeStoreSourceInput {
  lock: WorktreeStoreLock
  target: WorktreeStoreTarget
  channel: Channel
  env: Record<string, string | undefined>
}

export type WorktreeStoreSource =
  | { kind: "pinned"; pin: WorktreeStorePin }
  | { kind: "local"; path: string }
  | { kind: "unavailable" }

export function resolveWorktreeStoreSource(input: WorktreeStoreSourceInput): WorktreeStoreSource {
  const local = input.env[WORKTREE_STORE_DEV_ARCHIVE_ENV]
  if (local && input.channel !== "dev") {
    fail(
      "dev-override-rejected",
      `${WORKTREE_STORE_DEV_ARCHIVE_ENV} is a development-only worktree-store override; ${input.channel} packaging must stage the pinned archive`,
    )
  }
  const pin = input.lock.targets[input.target]
  if (pin) {
    if (local) {
      fail(
        "dev-override-rejected",
        `a pinned worktree-store target exists for ${input.target}; unset ${WORKTREE_STORE_DEV_ARCHIVE_ENV} to stage the pinned archive`,
      )
    }
    return { kind: "pinned", pin }
  }
  if (input.channel !== "dev") {
    fail(
      "missing-target",
      `no worktree-store target is pinned for ${input.target}; ${input.channel} packaging fails closed instead of shipping an unverified sidecar`,
    )
  }
  if (local) return { kind: "local", path: local }
  return { kind: "unavailable" }
}
