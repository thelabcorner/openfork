import { createHash } from "node:crypto"
import { lstat, readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { WORKTREE_STORE_CLI_CANDIDATES, isWorktreeStoreCliCandidate } from "../src/main/worktree-store-layout"

export const WORKTREE_STORE_BUNDLE_SCHEMA_VERSION = 1
export const WORKTREE_STORE_BUNDLE_KIND = "worktree-store-packaging-bundle"
export const WORKTREE_STORE_BUNDLE_NAME = "worktree-store"
export const WORKTREE_STORE_STAGE_SCHEMA_VERSION = 1
export const WORKTREE_STORE_BUNDLE_MANIFEST_FILE = "worktree-store-bundle.json"

// Files owned by the repository inside the staged output directory. Staging
// must never overwrite them and a staged payload must never contain them.
export const WORKTREE_STORE_PRESERVED_FILES = ["worktree-store.lock.json"] as const

export class WorktreeStoreVerificationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "WorktreeStoreVerificationError"
  }
}

function fail(code: string, message: string): never {
  throw new WorktreeStoreVerificationError(code, message)
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:[\\/]/

export function assertSafeRelativePath(value: string, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("unsafe-path", `${where}: expected a non-empty archive-relative path`)
  }
  if (value.includes("\0")) fail("unsafe-path", `${where}: archive path contains a NUL byte`)
  if (value.includes("\\")) {
    fail("unsafe-path", `${where}: archive path "${value}" contains a backslash; archives must use forward slashes`)
  }
  if (value.startsWith("/") || WINDOWS_DRIVE_PATTERN.test(value)) {
    fail("unsafe-path", `${where}: archive path "${value}" must be relative`)
  }
  const segments = value.split("/")
  for (const segment of segments) {
    if (segment === "" && segments.length > 1) {
      fail("unsafe-path", `${where}: archive path "${value}" contains an empty segment`)
    }
    if (segment === "." || segment === "..") {
      fail("unsafe-path", `${where}: archive path "${value}" contains a traversal segment`)
    }
  }
  if (segments.length === 1 && segments[0] === "") {
    fail("unsafe-path", `${where}: archive path must not be empty`)
  }
  return segments.join("/")
}

export function assertSafeArchiveEntry(value: string, where: string): string {
  const directory = value.endsWith("/")
  const normalized = assertSafeRelativePath(directory ? value.slice(0, -1) : value, where)
  return normalized
}

export function assertSafeArchiveEntries(entries: readonly string[], where: string): string[] {
  if (entries.length === 0) fail("unsafe-path", `${where}: archive listing is empty`)
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const entry of entries) {
    const safe = assertSafeArchiveEntry(entry, where)
    if (seen.has(safe)) fail("duplicate-entry", `${where}: archive lists "${safe}" more than once`)
    seen.add(safe)
    normalized.push(safe)
  }
  return normalized
}

export type WorktreeStoreHelperId = "refs-block-clone" | "storage-probe"

export const WORKTREE_STORE_HELPER_NAMES: Readonly<Record<WorktreeStoreHelperId, string>> = {
  "refs-block-clone": "worktree-store-refs-block-clone",
  "storage-probe": "worktree-store-storage-probe",
}

export type WorktreeStoreHelperArch = "x64" | "arm64" | "x86"

export interface WorktreeStoreHelperTarget {
  os: "windows"
  arch: WorktreeStoreHelperArch
}

export interface WorktreeStoreHelperProtocols {
  manifest?: { magic: string; version: number }
  success: { schemaVersion: number }
}

export interface WorktreeStoreHelperIdentity {
  helperName: string
  helperVersion: string
  sourceCompatibility: string
  protocols: WorktreeStoreHelperProtocols
}

export interface WorktreeStoreBundleHelper {
  id: WorktreeStoreHelperId
  relativePath: string
  sizeBytes: number
  sha256: string
  target: WorktreeStoreHelperTarget
  identity: WorktreeStoreHelperIdentity
}

export interface WorktreeStoreBundleManifest {
  schemaVersion: 1
  kind: typeof WORKTREE_STORE_BUNDLE_KIND
  bundle: {
    name: typeof WORKTREE_STORE_BUNDLE_NAME
    packageVersion: string
    managedProtocolVersion: string | null
    sourceRevision: string | null
    target: WorktreeStoreHelperTarget
  }
  helpers: WorktreeStoreBundleHelper[]
}

const HELPER_IDS: readonly WorktreeStoreHelperId[] = ["refs-block-clone", "storage-probe"]
const HELPER_ARCHES: readonly WorktreeStoreHelperArch[] = ["x64", "arm64", "x86"]
const VERSION_TOKEN_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/
const REVISION_TOKEN_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]{1,64})?$/
const SOURCE_COMPATIBILITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@/+-]{0,127}$/
const PROTOCOL_MAGIC_PATTERN = /^[A-Za-z0-9._-]{1,32}$/
const HELPER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

function expectObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("manifest-invalid", `${where}: expected an object`)
  }
  return value as Record<string, unknown>
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail("manifest-invalid", `${where}: unknown field "${key}"; expected one of ${allowed.join(", ")}`)
    }
  }
}

function expectExactKeys(record: Record<string, unknown>, keys: readonly string[], where: string): void {
  rejectUnknownKeys(record, keys, where)
  for (const key of keys) {
    if (!(key in record)) fail("manifest-invalid", `${where}: missing required field "${key}"`)
  }
}

function expectStringValue(
  record: Record<string, unknown>,
  key: string,
  where: string,
  options: { pattern?: RegExp; maxLength?: number } = {},
): string {
  const value = record[key]
  if (typeof value !== "string" || value.length === 0) {
    fail("manifest-invalid", `${where}.${key} must be a non-empty string`)
  }
  const maxLength = options.maxLength ?? 1024
  if (value.length > maxLength) fail("manifest-invalid", `${where}.${key} is longer than ${maxLength} characters`)
  if (options.pattern !== undefined && !options.pattern.test(value)) {
    fail("manifest-invalid", `${where}.${key} is outside the accepted format`)
  }
  return value
}

function expectNullableStringValue(
  record: Record<string, unknown>,
  key: string,
  where: string,
  options: { pattern?: RegExp; maxLength?: number } = {},
): string | null {
  if (record[key] === null) return null
  return expectStringValue(record, key, where, options)
}

function expectIntegerValue(record: Record<string, unknown>, key: string, where: string, minimum: number): number {
  const value = record[key]
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail("manifest-invalid", `${where}.${key} must be an integer >= ${minimum}`)
  }
  return value as number
}

function expectBundleRelativePath(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("unsafe-path", `${where}: expected a non-empty bundle-relative path`)
  }
  if (value.length > 512) fail("unsafe-path", `${where}: bundle-relative path exceeds 512 characters`)
  if (value.includes("\\")) fail("unsafe-path", `${where}: bundle-relative path "${value}" must use forward slashes`)
  if (value.includes("\0") || value.includes(":")) {
    fail("unsafe-path", `${where}: bundle-relative path "${value}" contains a forbidden character`)
  }
  if (value.startsWith("/")) fail("unsafe-path", `${where}: bundle-relative path "${value}" must remain relative`)
  for (const component of value.split("/")) {
    if (component.length === 0) fail("unsafe-path", `${where}: bundle-relative path "${value}" contains an empty component`)
    if (component === "." || component === "..") {
      fail("unsafe-path", `${where}: bundle-relative path "${value}" contains a traversal component`)
    }
    if (component.endsWith(".") || component.endsWith(" ")) {
      fail("unsafe-path", `${where}: bundle-relative path "${value}" contains a Windows-aliasing component`)
    }
  }
  return value
}

function parseHelperTarget(raw: unknown, where: string): WorktreeStoreHelperTarget {
  const record = expectObject(raw, where)
  expectExactKeys(record, ["os", "arch"], where)
  if (record.os !== "windows") fail("manifest-invalid", `${where}.os must be "windows"`)
  const arch = record.arch
  if (typeof arch !== "string" || !(HELPER_ARCHES as readonly string[]).includes(arch)) {
    fail("manifest-invalid", `${where}.arch must be one of ${HELPER_ARCHES.join(", ")}`)
  }
  return { os: "windows", arch: arch as WorktreeStoreHelperArch }
}

function parseHelperProtocols(raw: unknown, where: string): WorktreeStoreHelperProtocols {
  const record = expectObject(raw, where)
  rejectUnknownKeys(record, ["manifest", "success"], where)
  if (!("success" in record)) fail("manifest-invalid", `${where}: missing required field "success"`)
  const success = expectObject(record.success, `${where}.success`)
  expectExactKeys(success, ["schemaVersion"], `${where}.success`)
  const protocols: WorktreeStoreHelperProtocols = {
    success: { schemaVersion: expectIntegerValue(success, "schemaVersion", `${where}.success`, 1) },
  }
  if (record.manifest !== undefined) {
    const manifest = expectObject(record.manifest, `${where}.manifest`)
    expectExactKeys(manifest, ["magic", "version"], `${where}.manifest`)
    protocols.manifest = {
      magic: expectStringValue(manifest, "magic", `${where}.manifest`, { pattern: PROTOCOL_MAGIC_PATTERN, maxLength: 32 }),
      version: expectIntegerValue(manifest, "version", `${where}.manifest`, 1),
    }
  }
  return protocols
}

function parseHelperIdentity(raw: unknown, where: string): WorktreeStoreHelperIdentity {
  const record = expectObject(raw, where)
  expectExactKeys(record, ["helperName", "helperVersion", "sourceCompatibility", "protocols"], where)
  return {
    helperName: expectStringValue(record, "helperName", where, { pattern: HELPER_NAME_PATTERN, maxLength: 64 }),
    helperVersion: expectStringValue(record, "helperVersion", where, { pattern: SEMVER_PATTERN, maxLength: 128 }),
    sourceCompatibility: expectStringValue(record, "sourceCompatibility", where, {
      pattern: SOURCE_COMPATIBILITY_PATTERN,
      maxLength: 128,
    }),
    protocols: parseHelperProtocols(record.protocols, `${where}.protocols`),
  }
}

function parseHelperEntry(raw: unknown, where: string, bundleTarget: WorktreeStoreHelperTarget): WorktreeStoreBundleHelper {
  const record = expectObject(raw, where)
  expectExactKeys(record, ["id", "relativePath", "sizeBytes", "sha256", "target", "identity"], where)
  const id = record.id
  if (typeof id !== "string" || !(HELPER_IDS as readonly string[]).includes(id)) {
    fail("manifest-invalid", `${where}.id is not a known worktree-store helper id`)
  }
  const helperId = id as WorktreeStoreHelperId
  const target = parseHelperTarget(record.target, `${where}.target`)
  if (target.os !== bundleTarget.os || target.arch !== bundleTarget.arch) {
    fail("manifest-invalid", `${where}.target does not match the bundle target ${bundleTarget.os}/${bundleTarget.arch}`)
  }
  const identity = parseHelperIdentity(record.identity, `${where}.identity`)
  if (identity.helperName !== WORKTREE_STORE_HELPER_NAMES[helperId]) {
    fail("manifest-invalid", `${where}.identity.helperName does not match helper id ${helperId}`)
  }
  if (helperId === "refs-block-clone" && identity.protocols.manifest === undefined) {
    fail("manifest-invalid", `${where}.identity.protocols is missing the manifest protocol`)
  }
  if (helperId === "storage-probe" && identity.protocols.manifest !== undefined) {
    fail("manifest-invalid", `${where}.identity.protocols contains an unexpected manifest protocol`)
  }
  return {
    id: helperId,
    relativePath: expectBundleRelativePath(record.relativePath, `${where}.relativePath`),
    sizeBytes: expectIntegerValue(record, "sizeBytes", where, 1),
    sha256: expectStringValue(record, "sha256", where, { pattern: SHA256_PATTERN, maxLength: 64 }),
    target,
    identity,
  }
}

export function parseWorktreeStoreBundleManifest(raw: unknown, where: string): WorktreeStoreBundleManifest {
  const record = expectObject(raw, where)
  expectExactKeys(record, ["schemaVersion", "kind", "bundle", "helpers"], where)
  if (record.schemaVersion !== WORKTREE_STORE_BUNDLE_SCHEMA_VERSION) {
    fail("manifest-invalid", `${where}.schemaVersion is not supported`)
  }
  if (record.kind !== WORKTREE_STORE_BUNDLE_KIND) {
    fail("manifest-invalid", `${where}.kind is not "${WORKTREE_STORE_BUNDLE_KIND}"`)
  }
  const bundleRecord = expectObject(record.bundle, `${where}.bundle`)
  expectExactKeys(
    bundleRecord,
    ["name", "packageVersion", "managedProtocolVersion", "sourceRevision", "target"],
    `${where}.bundle`,
  )
  if (bundleRecord.name !== WORKTREE_STORE_BUNDLE_NAME) {
    fail("manifest-invalid", `${where}.bundle.name is not "${WORKTREE_STORE_BUNDLE_NAME}"`)
  }
  const bundle: WorktreeStoreBundleManifest["bundle"] = {
    name: WORKTREE_STORE_BUNDLE_NAME,
    packageVersion: expectStringValue(bundleRecord, "packageVersion", `${where}.bundle`, {
      pattern: VERSION_TOKEN_PATTERN,
      maxLength: 128,
    }),
    managedProtocolVersion: expectNullableStringValue(bundleRecord, "managedProtocolVersion", `${where}.bundle`, {
      pattern: VERSION_TOKEN_PATTERN,
      maxLength: 128,
    }),
    sourceRevision: expectNullableStringValue(bundleRecord, "sourceRevision", `${where}.bundle`, {
      pattern: REVISION_TOKEN_PATTERN,
      maxLength: 128,
    }),
    target: parseHelperTarget(bundleRecord.target, `${where}.bundle.target`),
  }

  if (!Array.isArray(record.helpers) || record.helpers.length === 0) {
    fail("manifest-invalid", `${where}.helpers must be a non-empty array`)
  }
  const helpers = record.helpers.map((entry, index) =>
    parseHelperEntry(entry, `${where}.helpers[${index}]`, bundle.target),
  )
  for (let index = 1; index < helpers.length; index += 1) {
    if (helpers[index - 1]!.id >= helpers[index]!.id) {
      fail("manifest-invalid", `${where}.helpers must be sorted by id without duplicates`)
    }
  }
  return { schemaVersion: WORKTREE_STORE_BUNDLE_SCHEMA_VERSION, kind: WORKTREE_STORE_BUNDLE_KIND, bundle, helpers }
}

export function verifyWorktreeStoreBundleTarget(
  manifest: WorktreeStoreBundleManifest,
  targetKey: string,
  where: string,
): void {
  const [platform, arch] = targetKey.split("-")
  if (platform !== "win32") {
    fail(
      "manifest-target",
      `${where}: pinned target ${targetKey} cannot carry a worktree-store bundle; producer bundle manifests are windows-only`,
    )
  }
  const target = manifest.bundle.target
  if (target.os !== "windows" || target.arch !== arch) {
    fail(
      "manifest-target",
      `${where}: bundle manifest target ${target.os}/${target.arch} does not match pinned target ${targetKey}`,
    )
  }
}

export function verifyWorktreeStoreCliDiscoverable(cli: string, targetKey: string, where: string): void {
  if (!targetKey.startsWith("win32-")) return
  if (isWorktreeStoreCliCandidate(cli)) return
  fail(
    "layout-mismatch",
    `${where}: pinned cli "${cli}" is not discoverable by the packaged desktop runtime; expected one of ${WORKTREE_STORE_CLI_CANDIDATES.join(", ")}`,
  )
}

export function verifyArchiveBytes(
  bytes: Uint8Array,
  expected: { sha256: string; size: number },
  where: string,
): void {
  if (bytes.byteLength !== expected.size) {
    fail("archive-size", `${where}: expected ${expected.size} bytes, got ${bytes.byteLength}`)
  }
  const digest = sha256Hex(bytes)
  if (digest !== expected.sha256) {
    fail("archive-digest", `${where}: expected sha256 ${expected.sha256}, got ${digest}`)
  }
}

export function parseVersionOutput(text: string, where: string): string {
  const match = text.match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)
  if (!match) fail("handshake-output", `${where}: could not parse a version from "${text.trim()}"`)
  return match[1]!
}

export function normalizeVersion(value: string): string {
  return value.startsWith("v") ? value.slice(1) : value
}

export function verifyHandshake(
  expected: { cli: string; helper?: string },
  actual: { cli?: string; helper?: string },
  where: string,
): void {
  for (const channel of ["cli", "helper"] as const) {
    const want = expected[channel]
    if (want === undefined) continue
    const got = actual[channel]
    if (got === undefined) {
      fail("stale-handshake", `${where}: ${channel} did not report a version; expected ${want}`)
    }
    if (got !== want) {
      fail("stale-handshake", `${where}: ${channel} reported ${got}; expected ${want}`)
    }
  }
}

export interface WorktreeStoreStageStamp {
  schemaVersion: 1
  source: "pinned" | "dev-local"
  targetKey: string
  version: string
  lockDigest: string
  archiveSha256: string | null
  archiveSize: number | null
}

export function parseWorktreeStoreStageStamp(raw: unknown, where: string): WorktreeStoreStageStamp {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("stamp-invalid", `${where}: expected an object`)
  }
  const record = raw as Record<string, unknown>
  const allowed = ["schemaVersion", "source", "targetKey", "version", "lockDigest", "archiveSha256", "archiveSize"]
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail("stamp-invalid", `${where}: unknown field "${key}"; expected one of ${allowed.join(", ")}`)
  }
  if (record.schemaVersion !== WORKTREE_STORE_STAGE_SCHEMA_VERSION) {
    fail("stamp-invalid", `${where}: unsupported schemaVersion ${JSON.stringify(record.schemaVersion)}`)
  }
  const source = record.source
  if (source !== "pinned" && source !== "dev-local") {
    fail("stamp-invalid", `${where}: source must be "pinned" or "dev-local"`)
  }
  const targetKey = String(record.targetKey ?? "")
  if (!/^(darwin|linux|win32)-(x64|arm64)$/.test(targetKey)) {
    fail("stamp-invalid", `${where}: targetKey "${targetKey}" is not a platform-arch key`)
  }
  const version = String(record.version ?? "")
  if (version.length === 0) fail("stamp-invalid", `${where}: version must be a non-empty string`)
  const lockDigest = String(record.lockDigest ?? "")
  if (!SHA256_PATTERN.test(lockDigest)) {
    fail("stamp-invalid", `${where}: lockDigest must be a lowercase sha256 hex digest`)
  }
  const archiveSha256 = record.archiveSha256 === null ? null : String(record.archiveSha256 ?? "")
  if (archiveSha256 !== null && !SHA256_PATTERN.test(archiveSha256)) {
    fail("stamp-invalid", `${where}: archiveSha256 must be null or a lowercase sha256 hex digest`)
  }
  const archiveSizeRaw = record.archiveSize
  const archiveSize = archiveSizeRaw === null ? null : archiveSizeRaw
  if (archiveSize !== null && (typeof archiveSize !== "number" || !Number.isSafeInteger(archiveSize) || archiveSize <= 0)) {
    fail("stamp-invalid", `${where}: archiveSize must be null or a positive integer`)
  }
  if (source === "pinned" && (archiveSha256 === null || archiveSize === null)) {
    fail("stamp-invalid", `${where}: pinned staging must record the archive digest and size`)
  }
  return { schemaVersion: 1, source, targetKey, version, lockDigest, archiveSha256, archiveSize }
}

export function assertPackagedStageStamp(stamp: WorktreeStoreStageStamp, where: string): void {
  if (stamp.source !== "pinned") {
    fail("dev-local-stamp", `${where}: packaged worktree-store payload came from a development-only local override`)
  }
}

export function verifyWorktreeStoreStageStamp(
  stamp: WorktreeStoreStageStamp,
  expected: { lockDigest: string; targetKey: string; version: string; archiveSha256: string; archiveSize: number },
  where: string,
): void {
  if (stamp.lockDigest !== expected.lockDigest) {
    fail("stale-lock-stamp", `${where}: staged against lock digest ${stamp.lockDigest}; checked-in lock is ${expected.lockDigest}`)
  }
  if (stamp.targetKey !== expected.targetKey) {
    fail("stale-target", `${where}: staged target ${stamp.targetKey}; expected ${expected.targetKey}`)
  }
  if (stamp.version !== expected.version) {
    fail("stale-version", `${where}: staged version ${stamp.version}; expected ${expected.version}`)
  }
  if (stamp.archiveSha256 !== expected.archiveSha256 || stamp.archiveSize !== expected.archiveSize) {
    fail("stale-archive", `${where}: staged archive does not match the pinned archive digest/size`)
  }
}

async function collectExtractedFiles(root: string, current: string, files: string[]): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name)
    const relative = path.relative(root, full).split(path.sep).join("/")
    if (entry.isSymbolicLink()) {
      fail("symlink-entry", `extracted payload contains a symbolic link at "${relative}"`)
    }
    if (entry.isDirectory()) {
      await collectExtractedFiles(root, full, files)
      continue
    }
    if (!entry.isFile()) fail("unsafe-entry", `extracted payload contains an unsupported entry at "${relative}"`)
    files.push(relative)
  }
}

export async function verifyExtractedTree(
  root: string,
  manifest: WorktreeStoreBundleManifest,
  manifestPath: string,
  where: string,
  options: { allowUndeclared?: readonly string[] } = {},
): Promise<void> {
  const safeManifestPath = assertSafeRelativePath(manifestPath, `${where}.manifest`)
  const collected: string[] = []
  await collectExtractedFiles(root, root, collected)
  const expected = new Set(manifest.helpers.map((helper) => helper.relativePath))
  expected.add(safeManifestPath)
  for (const allowed of options.allowUndeclared ?? []) {
    expected.add(assertSafeRelativePath(allowed, `${where}.allowUndeclared`))
  }
  for (const relative of collected) {
    if (!expected.has(relative)) fail("unexpected-file", `${where}: extracted payload contains undeclared file "${relative}"`)
  }
  for (const helper of manifest.helpers) {
    if (!collected.includes(helper.relativePath)) {
      fail("missing-file", `${where}: bundle manifest lists missing helper "${helper.relativePath}"`)
    }
    const segments = helper.relativePath.split("/")
    const bytes = await readFile(path.join(root, ...segments))
    if (bytes.byteLength !== helper.sizeBytes) {
      fail("file-size", `${where}: "${helper.relativePath}" expected ${helper.sizeBytes} bytes, got ${bytes.byteLength}`)
    }
    const digest = sha256Hex(bytes)
    if (digest !== helper.sha256) {
      fail("file-digest", `${where}: "${helper.relativePath}" expected sha256 ${helper.sha256}, got ${digest}`)
    }
  }
  const manifestSegments = safeManifestPath.split("/")
  let manifestPresent = true
  try {
    await lstat(path.join(root, ...manifestSegments))
  } catch {
    manifestPresent = false
  }
  if (!manifestPresent) fail("missing-file", `${where}: expected manifest at "${safeManifestPath}"`)
}

export interface SourceFile {
  path: string
  content: string
}

const IMPORT_SPECIFIER_PATTERN = /(?:from\s*|require\s*\(\s*|import\s*\(\s*)(["'`])([^"'`\n]+)\1/g
const SOURCE_EXTENSION_PATTERN = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/
const SIBLING_MARKERS = ["worktree-store", "worktree_store", "worktreestore"]
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"]

function isSiblingWorktreeStoreName(value: string): boolean {
  const normalized = value.toLowerCase()
  return SIBLING_MARKERS.some((marker) => normalized.includes(marker))
}

function sourceCandidates(resolved: string): string[] {
  return [
    resolved,
    `${resolved}.ts`,
    `${resolved}.tsx`,
    `${resolved}.js`,
    `${resolved}.jsx`,
    `${resolved}.mjs`,
    `${resolved}.cjs`,
    `${resolved}/index.ts`,
    `${resolved}/index.tsx`,
    `${resolved}/index.js`,
    `${resolved}/index.jsx`,
  ]
}

function isSiblingWorktreeStoreSpecifier(value: string, from: string, sources: ReadonlySet<string>): boolean {
  if (!isSiblingWorktreeStoreName(value)) return false
  // Bare/absolute specifiers and relative paths escaping the desktop package
  // would bind the app to a sibling worktree-store checkout. A parent-relative
  // path is accepted only when it resolves to a source file inside this
  // package (for example scripts/ -> src/main/worktree-store-layout).
  if (!value.startsWith(".")) return true
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), value))
  if (resolved.startsWith("../") || path.posix.isAbsolute(resolved)) return true
  return !sourceCandidates(resolved).some((candidate) => sources.has(candidate))
}

export function findSiblingWorktreeStoreImports(files: readonly SourceFile[]): string[] {
  const sources = new Set(files.map((file) => file.path))
  const violations: string[] = []
  for (const file of files) {
    if (SOURCE_EXTENSION_PATTERN.test(file.path)) {
      for (const match of file.content.matchAll(IMPORT_SPECIFIER_PATTERN)) {
        const specifier = match[2]!
        if (isSiblingWorktreeStoreSpecifier(specifier, file.path, sources)) {
          violations.push(`${file.path}: imports "${specifier}"`)
        }
      }
      continue
    }
    if (!file.path.endsWith("package.json")) continue
    let manifest: unknown
    try {
      manifest = JSON.parse(file.content)
    } catch {
      continue
    }
    if (typeof manifest !== "object" || manifest === null) continue
    for (const section of DEPENDENCY_SECTIONS) {
      const record = (manifest as Record<string, unknown>)[section]
      if (typeof record !== "object" || record === null) continue
      for (const key of Object.keys(record)) {
        if (isSiblingWorktreeStoreName(key)) violations.push(`${file.path}: ${section}."${key}"`)
      }
    }
  }
  return violations
}

export async function digestOfFile(file: string): Promise<string | undefined> {
  try {
    return sha256Hex(await readFile(file))
  } catch {
    return undefined
  }
}

export function mappedExecutableReusable(
  platform: string,
  installedDigest: string | undefined,
  stagedDigest: string,
): boolean {
  return platform === "win32" && installedDigest !== undefined && installedDigest === stagedDigest
}
