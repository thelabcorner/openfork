import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { createHash } from "node:crypto"
import path from "node:path"
import { Context, Duration, Effect, Exit, Layer, Option } from "effect"
import {
  UnavailableError,
  ManagedWorktreeManager,
  MANAGED_TIMEOUTS,
  type Error as ManagedError,
  type ManagedExecutable,
} from "./client"
import {
  MANAGED_PROTOCOL_COMMANDS,
  MANAGED_PROTOCOL_VERSION,
  type ManagedFenceAdapterCapability,
  type ManagedProtocolVersionResult,
} from "./protocol"

export const WORKTREE_STORE_ROOT_ENV = "OPENFORK_WORKTREE_STORE_ROOT"
export const WORKTREE_STORE_CLI_ENV = "OPENFORK_WORKTREE_STORE_CLI"
export const WORKTREE_STORE_DISCOVERY_DIR_ENV = "OPENFORK_WORKTREE_STORE_DISCOVERY_DIR"
export const WORKTREE_STORE_CONTROL_PLANE_ROOT_ENV = "OPENFORK_WORKTREE_STORE_CONTROL_PLANE_ROOT"
export const WORKTREE_STORE_RESOURCE_DIRECTORY = "worktree-store"
/**
 * Conventional names the staged payload uses for the managed CLI executable.
 * The pinned lock records the exact name per target; these are the names the
 * published bundles stage today, checked in order and all contained in the
 * verified stage root.
 */
export const WORKTREE_STORE_CONVENTIONAL_CLI_NAMES = Object.freeze([
  "worktree-store.exe",
  "bin/worktree-store.exe",
  "worktree-store",
  "bin/worktree-store",
] as const)
export const WORKTREE_STORE_VERSION_FILE = "VERSION"
export const WORKTREE_STORE_STAGE_FILE = "STAGE.json"
export const WORKTREE_STORE_BUNDLE_MANIFEST_FILE = "worktree-store-bundle.json"
export const WORKTREE_STORE_BUNDLE_SCHEMA_VERSION = 1
export const WORKTREE_STORE_BUNDLE_KIND = "worktree-store-packaging-bundle"
export const WORKTREE_STORE_BUNDLE_NAME = "worktree-store"
export const WORKTREE_STORE_STAGE_SCHEMA_VERSION = 1
export const WORKTREE_STORE_MANAGED_PROTOCOL_TOKEN = String(MANAGED_PROTOCOL_VERSION)

export const CAPABILITY_CODES = Object.freeze({
  rootMissing: "capability-root-missing",
  rootNotAbsolute: "capability-root-not-absolute",
  rootNotDirectory: "capability-root-not-directory",
  rootInsideAsar: "capability-root-inside-asar",
  stageMissing: "capability-stage-missing",
  stageInvalid: "capability-stage-invalid",
  devLocalInProduction: "capability-dev-local-in-production",
  platformUnsupported: "capability-platform-unsupported",
  targetMismatch: "capability-target-mismatch",
  versionMismatch: "capability-version-mismatch",
  protocolUnsupported: "capability-protocol-unsupported",
  manifestMissing: "capability-manifest-missing",
  manifestInvalid: "capability-manifest-invalid",
  cliMissing: "capability-cli-missing",
  cliEscape: "capability-cli-escape",
  discoveryDirectoryNotAbsolute: "capability-discovery-directory-not-absolute",
  discoveryDirectoryInvalid: "capability-discovery-directory-invalid",
  helperInvalid: "capability-helper-invalid",
  fallbackForbidden: "capability-fallback-forbidden",
})

export type ManagerMode = "production" | "dev"

export interface ManagedStageIdentity {
  readonly schemaVersion: typeof WORKTREE_STORE_STAGE_SCHEMA_VERSION
  readonly source: "pinned" | "dev-local"
  readonly targetKey: string
  readonly version: string
  readonly lockDigest: string
  readonly archiveSha256: string | null
  readonly archiveSize: number | null
}

export interface ManagedHelperTarget {
  readonly os: "windows"
  readonly arch: "x64" | "arm64" | "x86"
}

export interface ManagedHelperProtocols {
  readonly manifest?: { readonly magic: string; readonly version: number }
  readonly success: { readonly schemaVersion: number }
}

export interface ManagedBundleHelperIdentity {
  readonly helperName: string
  readonly helperVersion: string
  readonly sourceCompatibility: string
  readonly protocols: ManagedHelperProtocols
}

export interface ManagedBundleHelper {
  readonly id: string
  readonly relativePath: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly target: ManagedHelperTarget
  readonly identity: ManagedBundleHelperIdentity
}

export interface ManagedBundleManifest {
  readonly schemaVersion: typeof WORKTREE_STORE_BUNDLE_SCHEMA_VERSION
  readonly kind: string
  readonly bundle: {
    readonly name: string
    readonly packageVersion: string
    readonly managedProtocolVersion: string | null
    readonly sourceRevision: string | null
    readonly target: ManagedHelperTarget
  }
  readonly helpers: readonly ManagedBundleHelper[]
}

export interface VerifiedManagedHelper {
  readonly id: string
  readonly relativePath: string
  readonly absolutePath: string
  readonly sizeBytes: number
  readonly sha256: string
}

export interface ManagedManagerDescriptor {
  readonly mode: ManagerMode
  readonly root: string
  readonly cliFile: string
  readonly executable: ManagedExecutable
  readonly stage: ManagedStageIdentity
  readonly stageDigest: string
  readonly version: string
  readonly manifest: ManagedBundleManifest
  readonly helpers: readonly VerifiedManagedHelper[]
  readonly handshake: ManagedProtocolVersionResult
  /** Resolved OpenFork service-discovery directory, when one is configured. */
  readonly discoveryDirectory: string | null
  /** Parsed activity-fence adapter capability advertised by the sidecar. */
  readonly fenceAdapter: ManagedFenceAdapterCapability
  readonly neverFallsBackToUnmanagedGit: true
}

export type ManagedExecutableLauncher = (input: {
  readonly cliFile: string
  readonly root: string
}) => ManagedExecutable

export interface ResolutionOptions {
  readonly root?: string
  readonly cli?: string
  readonly discoveryDirectory?: string
  readonly mode?: ManagerMode
  readonly env?: Record<string, string | undefined>
  readonly launcher?: ManagedExecutableLauncher
  readonly handshakeTimeout?: Duration.Input
}

export interface Interface {
  readonly resolve: (options?: ResolutionOptions) => Effect.Effect<ManagedManagerDescriptor, ManagedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ManagedWorktreeCapability") {}

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const VERSION_TOKEN_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/
const REVISION_TOKEN_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/
const TARGET_KEY_PATTERN = /^(darwin|linux|win32)-(x64|arm64|x86)$/
const HELPER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const HELPER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const SOURCE_COMPATIBILITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@/+-]{0,127}$/
const PROTOCOL_MAGIC_PATTERN = /^[A-Za-z0-9._-]{1,32}$/

function reject(code: string, message: string): never {
  throw new UnavailableError({ code, message })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireObject(value: unknown, at: string, code: string): Record<string, unknown> {
  if (!isRecord(value)) reject(code, `${at} must be a JSON object.`)
  return value
}

function requireExactKeys(object: Record<string, unknown>, keys: readonly string[], at: string, code: string): void {
  for (const key of Object.keys(object)) {
    if (!keys.includes(key)) reject(code, `${at}.${key} is not a recognized field.`)
  }
  for (const key of keys) {
    if (!(key in object)) reject(code, `${at}.${key} is required.`)
  }
}

function requireString(
  object: Record<string, unknown>,
  key: string,
  at: string,
  code: string,
  options: { pattern?: RegExp; maxLength?: number } = {},
): string {
  const value = object[key]
  if (typeof value !== "string" || value.length === 0) reject(code, `${at}.${key} must be a non-empty string.`)
  const maxLength = options.maxLength ?? 1024
  if (value.length > maxLength) reject(code, `${at}.${key} exceeds ${maxLength} characters.`)
  if (options.pattern !== undefined && !options.pattern.test(value)) {
    reject(code, `${at}.${key} is outside the accepted format.`)
  }
  return value
}

function requireNullableString(
  object: Record<string, unknown>,
  key: string,
  at: string,
  code: string,
  options: { pattern?: RegExp; maxLength?: number } = {},
): string | null {
  if (object[key] === null) return null
  return requireString(object, key, at, code, options)
}

function requireInteger(
  object: Record<string, unknown>,
  key: string,
  at: string,
  code: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = object[key]
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    reject(code, `${at}.${key} must be an integer from ${minimum} to ${maximum}.`)
  }
  return value
}

function requireNullableInteger(
  object: Record<string, unknown>,
  key: string,
  at: string,
  code: string,
  minimum: number,
): number | null {
  if (object[key] === null) return null
  return requireInteger(object, key, at, code, minimum)
}

export function assertBundleRelativePath(
  value: unknown,
  at: string,
  code: string = CAPABILITY_CODES.manifestInvalid,
): string {
  if (typeof value !== "string" || value.length === 0) {
    reject(code, `${at} must be a non-empty bundle-relative path.`)
  }
  if (value.length > 512) reject(code, `${at} exceeds 512 characters.`)
  if (value.includes("\\")) reject(code, `${at} must use forward slashes.`)
  if (value.includes("\0") || value.includes(":")) {
    reject(code, `${at} contains a forbidden character.`)
  }
  if (value.startsWith("/")) reject(code, `${at} must remain relative.`)
  for (const component of value.split("/")) {
    if (component.length === 0) reject(code, `${at} contains an empty component.`)
    if (component === "." || component === "..") {
      reject(code, `${at} contains a traversal component.`)
    }
    if (component.endsWith(".") || component.endsWith(" ")) {
      reject(code, `${at} contains a Windows-aliasing component.`)
    }
  }
  return value
}

export function parseManagedStageIdentity(value: unknown, at = "STAGE.json"): ManagedStageIdentity {
  const code = CAPABILITY_CODES.stageInvalid
  const object = requireObject(value, at, code)
  requireExactKeys(
    object,
    ["schemaVersion", "source", "targetKey", "version", "lockDigest", "archiveSha256", "archiveSize"],
    at,
    code,
  )
  if (object.schemaVersion !== WORKTREE_STORE_STAGE_SCHEMA_VERSION) {
    reject(code, `${at}.schemaVersion must be ${WORKTREE_STORE_STAGE_SCHEMA_VERSION}.`)
  }
  const source = object.source
  if (source !== "pinned" && source !== "dev-local") {
    reject(code, `${at}.source must be "pinned" or "dev-local".`)
  }
  const targetKey = requireString(object, "targetKey", at, code, { pattern: TARGET_KEY_PATTERN, maxLength: 32 })
  const version = requireString(object, "version", at, code, { pattern: VERSION_TOKEN_PATTERN, maxLength: 128 })
  const lockDigest = requireString(object, "lockDigest", at, code, { pattern: SHA256_PATTERN, maxLength: 64 })
  const archiveSha256 = requireNullableString(object, "archiveSha256", at, code, {
    pattern: SHA256_PATTERN,
    maxLength: 64,
  })
  const archiveSize = requireNullableInteger(object, "archiveSize", at, code, 1)
  if (source === "pinned" && (archiveSha256 === null || archiveSize === null)) {
    reject(code, `${at} must record the pinned archive digest and size for a pinned stage.`)
  }
  return Object.freeze({
    schemaVersion: WORKTREE_STORE_STAGE_SCHEMA_VERSION,
    source,
    targetKey,
    version,
    lockDigest,
    archiveSha256,
    archiveSize,
  })
}

function parseHelperTarget(value: unknown, at: string): ManagedHelperTarget {
  const code = CAPABILITY_CODES.manifestInvalid
  const object = requireObject(value, at, code)
  requireExactKeys(object, ["os", "arch"], at, code)
  if (object.os !== "windows") reject(code, `${at}.os must be "windows".`)
  const arch = object.arch
  if (arch !== "x64" && arch !== "arm64" && arch !== "x86") {
    reject(code, `${at}.arch must be one of: x64, arm64, x86.`)
  }
  return Object.freeze({ os: "windows" as const, arch })
}

function parseHelperProtocols(value: unknown, at: string): ManagedHelperProtocols {
  const code = CAPABILITY_CODES.manifestInvalid
  const object = requireObject(value, at, code)
  if (!("success" in object)) reject(code, `${at}.success is required.`)
  const success = requireObject(object.success, `${at}.success`, code)
  requireExactKeys(success, ["schemaVersion"], `${at}.success`, code)
  const protocols: { manifest?: { magic: string; version: number }; success: { schemaVersion: number } } = {
    success: Object.freeze({
      schemaVersion: requireInteger(success, "schemaVersion", `${at}.success`, code, 1),
    }),
  }
  if (object.manifest !== undefined) {
    const manifest = requireObject(object.manifest, `${at}.manifest`, code)
    requireExactKeys(manifest, ["magic", "version"], `${at}.manifest`, code)
    protocols.manifest = Object.freeze({
      magic: requireString(manifest, "magic", `${at}.manifest`, code, {
        pattern: PROTOCOL_MAGIC_PATTERN,
        maxLength: 32,
      }),
      version: requireInteger(manifest, "version", `${at}.manifest`, code, 1),
    })
  }
  for (const key of Object.keys(object)) {
    if (key !== "manifest" && key !== "success") reject(code, `${at}.${key} is not a recognized field.`)
  }
  return Object.freeze(protocols)
}

function parseHelperIdentity(value: unknown, at: string): ManagedBundleHelperIdentity {
  const code = CAPABILITY_CODES.manifestInvalid
  const object = requireObject(value, at, code)
  requireExactKeys(object, ["helperName", "helperVersion", "sourceCompatibility", "protocols"], at, code)
  return Object.freeze({
    helperName: requireString(object, "helperName", at, code, { pattern: HELPER_NAME_PATTERN, maxLength: 64 }),
    helperVersion: requireString(object, "helperVersion", at, code, {
      pattern: VERSION_TOKEN_PATTERN,
      maxLength: 128,
    }),
    sourceCompatibility: requireString(object, "sourceCompatibility", at, code, {
      pattern: SOURCE_COMPATIBILITY_PATTERN,
      maxLength: 128,
    }),
    protocols: parseHelperProtocols(object.protocols, `${at}.protocols`),
  })
}

function parseBundleHelper(value: unknown, at: string, bundleTarget: ManagedHelperTarget): ManagedBundleHelper {
  const code = CAPABILITY_CODES.manifestInvalid
  const object = requireObject(value, at, code)
  requireExactKeys(object, ["id", "relativePath", "sizeBytes", "sha256", "target", "identity"], at, code)
  const id = requireString(object, "id", at, code, { pattern: HELPER_ID_PATTERN, maxLength: 64 })
  const target = parseHelperTarget(object.target, `${at}.target`)
  if (target.os !== bundleTarget.os || target.arch !== bundleTarget.arch) {
    reject(code, `${at}.target must match the bundle target ${bundleTarget.os}/${bundleTarget.arch}.`)
  }
  const identity = parseHelperIdentity(object.identity, `${at}.identity`)
  if (id === "refs-block-clone" && identity.protocols.manifest === undefined) {
    reject(code, `${at}.identity.protocols is missing the manifest protocol.`)
  }
  if (id === "storage-probe" && identity.protocols.manifest !== undefined) {
    reject(code, `${at}.identity.protocols contains an unexpected manifest protocol.`)
  }
  return Object.freeze({
    id,
    relativePath: assertBundleRelativePath(object.relativePath, `${at}.relativePath`),
    sizeBytes: requireInteger(object, "sizeBytes", at, code, 1),
    sha256: requireString(object, "sha256", at, code, { pattern: SHA256_PATTERN, maxLength: 64 }),
    target,
    identity,
  })
}

export function parseManagedBundleManifest(value: unknown, at = WORKTREE_STORE_BUNDLE_MANIFEST_FILE): ManagedBundleManifest {
  const code = CAPABILITY_CODES.manifestInvalid
  const object = requireObject(value, at, code)
  requireExactKeys(object, ["schemaVersion", "kind", "bundle", "helpers"], at, code)
  if (object.schemaVersion !== WORKTREE_STORE_BUNDLE_SCHEMA_VERSION) {
    reject(code, `${at}.schemaVersion must be ${WORKTREE_STORE_BUNDLE_SCHEMA_VERSION}.`)
  }
  if (object.kind !== WORKTREE_STORE_BUNDLE_KIND) reject(code, `${at}.kind must be "${WORKTREE_STORE_BUNDLE_KIND}".`)

  const bundleAt = `${at}.bundle`
  const bundleObject = requireObject(object.bundle, bundleAt, code)
  requireExactKeys(
    bundleObject,
    ["name", "packageVersion", "managedProtocolVersion", "sourceRevision", "target"],
    bundleAt,
    code,
  )
  if (bundleObject.name !== WORKTREE_STORE_BUNDLE_NAME) {
    reject(code, `${bundleAt}.name must be "${WORKTREE_STORE_BUNDLE_NAME}".`)
  }
  const bundle = Object.freeze({
    name: WORKTREE_STORE_BUNDLE_NAME,
    packageVersion: requireString(bundleObject, "packageVersion", bundleAt, code, {
      pattern: VERSION_TOKEN_PATTERN,
      maxLength: 128,
    }),
    managedProtocolVersion: requireNullableString(bundleObject, "managedProtocolVersion", bundleAt, code, {
      pattern: VERSION_TOKEN_PATTERN,
      maxLength: 128,
    }),
    sourceRevision: requireNullableString(bundleObject, "sourceRevision", bundleAt, code, {
      pattern: REVISION_TOKEN_PATTERN,
      maxLength: 128,
    }),
    target: parseHelperTarget(bundleObject.target, `${bundleAt}.target`),
  })

  if (!Array.isArray(object.helpers) || object.helpers.length === 0) {
    reject(code, `${at}.helpers must be a non-empty array.`)
  }
  const helpers = object.helpers.map((entry, index) =>
    parseBundleHelper(entry, `${at}.helpers[${index}]`, bundle.target),
  )
  for (let index = 1; index < helpers.length; index += 1) {
    if (helpers[index - 1]!.id >= helpers[index]!.id) {
      reject(code, `${at}.helpers must be sorted by id without duplicates.`)
    }
  }
  return Object.freeze({
    schemaVersion: WORKTREE_STORE_BUNDLE_SCHEMA_VERSION,
    kind: WORKTREE_STORE_BUNDLE_KIND,
    bundle,
    helpers: Object.freeze(helpers),
  })
}

export function currentTargetKey(platform: string, arch: string): string | undefined {
  if (platform !== "win32") return undefined
  if (arch !== "x64" && arch !== "arm64") return undefined
  return `${platform}-${arch}`
}

function targetArchForTargetKey(targetKey: string): string {
  return targetKey.slice(targetKey.indexOf("-") + 1)
}

function containsAsar(root: string): boolean {
  return root.split(/[\\/]/).some((segment) => segment.toLowerCase() === "app.asar" || segment.toLowerCase().endsWith(".asar"))
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

const defaultLauncher: ManagedExecutableLauncher = (input) => ({
  path: input.cliFile,
  argsPrefix: [],
  cwd: input.root,
})

interface StagedPayload {
  readonly root: string
  readonly stage: ManagedStageIdentity
  readonly stageDigest: string
  readonly version: string
  readonly manifest: ManagedBundleManifest
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const manager = yield* ManagedWorktreeManager.Service
    const descriptors = new Map<string, Effect.Effect<ManagedManagerDescriptor, ManagedError>>()

    const readStage = Effect.fnUntraced(function* (options: ResolutionOptions) {
      const env = options.env ?? process.env
      const explicitRoot = options.root ?? env[WORKTREE_STORE_ROOT_ENV]
      const conventionalRoot = (() => {
        const resourcesPath = (process as { resourcesPath?: unknown }).resourcesPath
        if (typeof resourcesPath !== "string" || resourcesPath.length === 0) return undefined
        return path.join(resourcesPath, WORKTREE_STORE_RESOURCE_DIRECTORY)
      })()
      const root = explicitRoot ?? conventionalRoot
      if (root === undefined || root.length === 0) {
        return yield* new UnavailableError({
          code: CAPABILITY_CODES.rootMissing,
          message: `no worktree-store stage root is configured; set ${WORKTREE_STORE_ROOT_ENV} or provide an explicit root.`,
        })
      }
      if (!path.isAbsolute(root)) {
        return yield* new UnavailableError({
          code: CAPABILITY_CODES.rootNotAbsolute,
          message: `the worktree-store stage root must be an absolute path; received ${root}.`,
        })
      }
      if (containsAsar(root)) {
        return yield* new UnavailableError({
          code: CAPABILITY_CODES.rootInsideAsar,
          message: "the worktree-store stage root must live outside app.asar.",
        })
      }
      const realRoot = yield* fs.resolve(root)
      if (!(yield* fs.isDir(realRoot))) {
        return yield* new UnavailableError({
          code: CAPABILITY_CODES.rootNotDirectory,
          message: `the worktree-store stage root is not a directory: ${realRoot}.`,
        })
      }

      const readText = (file: string) =>
        fs.readFileStringSafe(file).pipe(
          Effect.catch((cause) =>
            Effect.fail(
              new UnavailableError({
                code: CAPABILITY_CODES.stageInvalid,
                message: `the worktree-store stage file could not be read: ${file} (${cause.message}).`,
              }),
            ),
          ),
        )

      const stageText = yield* readText(path.join(realRoot, WORKTREE_STORE_STAGE_FILE))
      if (stageText === undefined) {
        return yield* new UnavailableError({
          code: CAPABILITY_CODES.stageMissing,
          message: `the worktree-store stage is missing ${WORKTREE_STORE_STAGE_FILE} at ${realRoot}.`,
        })
      }
      const versionText = yield* readText(path.join(realRoot, WORKTREE_STORE_VERSION_FILE))
      if (versionText === undefined) {
        return yield* new UnavailableError({
          code: CAPABILITY_CODES.stageMissing,
          message: `the worktree-store stage is missing ${WORKTREE_STORE_VERSION_FILE} at ${realRoot}.`,
        })
      }
      const manifestText = yield* readText(path.join(realRoot, WORKTREE_STORE_BUNDLE_MANIFEST_FILE))
      if (manifestText === undefined) {
        return yield* new UnavailableError({
          code: CAPABILITY_CODES.manifestMissing,
          message: `the worktree-store stage is missing ${WORKTREE_STORE_BUNDLE_MANIFEST_FILE} at ${realRoot}.`,
        })
      }

      const stage = yield* Effect.try({
        try: () => parseManagedStageIdentity(parseStageJson(stageText)),
        catch: (cause) => asCapabilityError(cause, CAPABILITY_CODES.stageInvalid, "STAGE.json is not valid JSON."),
      })
      const manifest = yield* Effect.try({
        try: () => parseManagedBundleManifest(parseStageJson(manifestText)),
        catch: (cause) =>
          asCapabilityError(cause, CAPABILITY_CODES.manifestInvalid, "worktree-store-bundle.json is not valid JSON."),
      })

      return {
        root: realRoot,
        stage,
        stageDigest: sha256Hex([stageText, versionText, manifestText].join("\n")),
        version: versionText.trim(),
        manifest,
      } satisfies StagedPayload
    })

    const verifyHelpers = Effect.fnUntraced(function* (payload: StagedPayload) {
      const helpers: VerifiedManagedHelper[] = []
      for (const helper of payload.manifest.helpers) {
        const absolutePath = yield* resolveContainedFile(fs, payload.root, helper.relativePath, {
          escape: CAPABILITY_CODES.helperInvalid,
          missing: CAPABILITY_CODES.helperInvalid,
        })
        const bytes = yield* fs.readFile(absolutePath).pipe(
          Effect.catch((cause) =>
            Effect.fail(
              new UnavailableError({
                code: CAPABILITY_CODES.helperInvalid,
                message: `the worktree-store helper could not be read: ${absolutePath} (${cause.message}).`,
              }),
            ),
          ),
        )
        if (bytes.byteLength !== helper.sizeBytes) {
          return yield* new UnavailableError({
            code: CAPABILITY_CODES.helperInvalid,
            message: `worktree-store helper ${helper.relativePath} is ${bytes.byteLength} bytes; expected ${helper.sizeBytes}.`,
          })
        }
        const digest = sha256Hex(bytes)
        if (digest !== helper.sha256) {
          return yield* new UnavailableError({
            code: CAPABILITY_CODES.helperInvalid,
            message: `worktree-store helper ${helper.relativePath} does not match its manifest digest.`,
          })
        }
        helpers.push(
          Object.freeze({
            id: helper.id,
            relativePath: helper.relativePath,
            absolutePath,
            sizeBytes: helper.sizeBytes,
            sha256: helper.sha256,
          }),
        )
      }
      return Object.freeze(helpers)
    })

    const verify = Effect.fnUntraced(function* (payload: StagedPayload, options: ResolutionOptions) {
      const mode = options.mode ?? "production"
      if (mode === "production" && payload.stage.source !== "pinned") {
        return yield* new UnavailableError({
          code: CAPABILITY_CODES.devLocalInProduction,
          message: "the staged worktree-store payload came from a development-only local override.",
        })
      }
      const targetKey = currentTargetKey(process.platform, process.arch)
      if (targetKey === undefined) {
        return yield* new UnavailableError({
          code: CAPABILITY_CODES.platformUnsupported,
          message: `the managed worktree-store sidecar does not support ${process.platform}/${process.arch}.`,
        })
      }
      if (payload.stage.targetKey !== targetKey) {
        return yield* new UnavailableError({
          code: CAPABILITY_CODES.targetMismatch,
          message: `the staged worktree-store payload targets ${payload.stage.targetKey}; this host is ${targetKey}.`,
        })
      }
      if (payload.version !== payload.stage.version) {
        return yield* new UnavailableError({
          code: CAPABILITY_CODES.versionMismatch,
          message: `staged ${WORKTREE_STORE_VERSION_FILE} is ${payload.version}; STAGE.json records ${payload.stage.version}.`,
        })
      }
      if (payload.manifest.bundle.managedProtocolVersion !== WORKTREE_STORE_MANAGED_PROTOCOL_TOKEN) {
        return yield* new UnavailableError({
          code: CAPABILITY_CODES.protocolUnsupported,
          message: `the staged worktree-store bundle declares managed protocol ${String(payload.manifest.bundle.managedProtocolVersion)}; expected ${WORKTREE_STORE_MANAGED_PROTOCOL_TOKEN}.`,
        })
      }
      if (payload.stage.source === "pinned" && payload.manifest.bundle.packageVersion !== payload.stage.version) {
        return yield* new UnavailableError({
          code: CAPABILITY_CODES.versionMismatch,
          message: `the staged bundle package version ${payload.manifest.bundle.packageVersion} does not match the pinned version ${payload.stage.version}.`,
        })
      }
      if (payload.manifest.bundle.target.arch !== targetArchForTargetKey(payload.stage.targetKey)) {
        return yield* new UnavailableError({
          code: CAPABILITY_CODES.targetMismatch,
          message: "the staged bundle target does not match the staged target key.",
        })
      }

      const env = options.env ?? process.env
      const discoveryValue = options.discoveryDirectory ?? env[WORKTREE_STORE_DISCOVERY_DIR_ENV]
      let discoveryDirectory: string | null = null
      if (discoveryValue !== undefined && discoveryValue.length > 0) {
        if (!path.isAbsolute(discoveryValue)) {
          return yield* new UnavailableError({
            code: CAPABILITY_CODES.discoveryDirectoryNotAbsolute,
            message: "the OpenFork service-discovery directory must be an absolute path.",
          })
        }
        if (containsAsar(discoveryValue)) {
          return yield* new UnavailableError({
            code: CAPABILITY_CODES.discoveryDirectoryInvalid,
            message: "the OpenFork service-discovery directory must live outside app.asar.",
          })
        }
        discoveryDirectory = path.resolve(discoveryValue)
      }

      const cliValue = options.cli ?? env[WORKTREE_STORE_CLI_ENV]
      const cliFile =
        cliValue !== undefined && cliValue.length > 0
          ? yield* resolveContainedFile(fs, payload.root, cliValue, {
              escape: CAPABILITY_CODES.cliEscape,
              missing: CAPABILITY_CODES.cliMissing,
            })
          : yield* discoverConventionalCli(fs, payload.root)

      const helpers = yield* verifyHelpers(payload)
      const launcher = options.launcher ?? defaultLauncher
      const executable = launcher({ cliFile, root: payload.root })

      const handshake = yield* manager.protocolVersion({
        executable,
        timeout: options.handshakeTimeout ?? Duration.millis(MANAGED_TIMEOUTS.protocolVersionMs),
      })
      if (!handshake.capabilities.managedCreateInitialize.neverFallsBackToUnmanagedGit) {
        return yield* new UnavailableError({
          code: CAPABILITY_CODES.fallbackForbidden,
          message: "the managed worktree-store sidecar does not guarantee neverFallsBackToUnmanagedGit.",
        })
      }
      if (
        payload.stage.source === "pinned" &&
        handshake.packageVersion !== "unknown" &&
        handshake.packageVersion !== payload.stage.version
      ) {
        return yield* new UnavailableError({
          code: CAPABILITY_CODES.versionMismatch,
          message: `the managed sidecar reported version ${handshake.packageVersion}; the pinned stage records ${payload.stage.version}.`,
        })
      }
      for (const command of MANAGED_PROTOCOL_COMMANDS) {
        if (!handshake.commands.includes(command)) {
          return yield* new UnavailableError({
            code: CAPABILITY_CODES.protocolUnsupported,
            message: `the managed sidecar does not advertise the ${command} command.`,
          })
        }
      }

      return Object.freeze({
        mode,
        root: payload.root,
        cliFile,
        executable,
        stage: payload.stage,
        stageDigest: payload.stageDigest,
        version: payload.stage.version,
        manifest: payload.manifest,
        helpers,
        handshake,
        discoveryDirectory,
        fenceAdapter: handshake.capabilities.managedCreateInitialize.dedupeFenceAdapter,
        neverFallsBackToUnmanagedGit: true as const,
      }) satisfies ManagedManagerDescriptor
    })

    const resolve = Effect.fn("ManagedWorktreeCapability.resolve")(function* (options: ResolutionOptions = {}) {
      const payload = yield* readStage(options)
      const key = `${payload.root}\u0000${payload.stageDigest}`
      const cached = descriptors.get(key)
      if (cached !== undefined) return yield* cached
      let cell: Effect.Effect<ManagedManagerDescriptor, ManagedError> | undefined
      const verified = yield* Effect.cached(
        verify(payload, options).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.sync(() => {
                  if (cell !== undefined && descriptors.get(key) === cell) descriptors.delete(key)
                }),
          ),
        ),
      )
      cell = verified
      descriptors.set(key, verified)
      return yield* verified
    })

    return Service.of({ resolve })
  }),
)

function parseStageJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    reject(CAPABILITY_CODES.stageInvalid, "the worktree-store stage metadata is not valid JSON.")
  }
}

function asCapabilityError(cause: unknown, code: string, fallback: string): UnavailableError {
  if (cause instanceof UnavailableError) return cause
  if (cause instanceof globalThis.Error && cause.message.length > 0) {
    return new UnavailableError({ code, message: cause.message })
  }
  return new UnavailableError({ code, message: fallback })
}

/**
 * Find the managed CLI at its conventional staged location. Every candidate is
 * still resolved through the same containment and existence checks as an
 * explicit path; a missing payload fails closed with `cliMissing` instead of
 * inventing a path.
 */
function discoverConventionalCli(
  fs: FSUtil.Interface,
  root: string,
): Effect.Effect<string, UnavailableError> {
  return Effect.gen(function* () {
    for (const name of WORKTREE_STORE_CONVENTIONAL_CLI_NAMES) {
      const resolved = yield* resolveContainedFile(fs, root, name, {
        escape: CAPABILITY_CODES.cliEscape,
        missing: CAPABILITY_CODES.cliMissing,
      }).pipe(Effect.option)
      if (Option.isSome(resolved)) return resolved.value
    }
    return yield* new UnavailableError({
      code: CAPABILITY_CODES.cliMissing,
      message: `no managed worktree-store CLI was found in the stage root; set ${WORKTREE_STORE_CLI_ENV} or provide an explicit cli path.`,
    })
  })
}

function resolveContainedFile(
  fs: FSUtil.Interface,
  root: string,
  candidate: string,
  codes: { readonly escape: string; readonly missing: string },
): Effect.Effect<string, UnavailableError> {
  return Effect.gen(function* () {
    const relative = path.isAbsolute(candidate)
      ? undefined
      : yield* Effect.try({
          try: () => candidateRelative(candidate, codes.escape),
          catch: (cause) => asCapabilityError(cause, codes.escape, "the managed worktree-store path is invalid."),
        })
    const resolved = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(root, ...relative!.split("/"))
    if (!FSUtil.contains(root, resolved) || resolved === root) {
      return yield* new UnavailableError({
        code: codes.escape,
        message: `the managed worktree-store file escapes the stage root: ${candidate}.`,
      })
    }
    if (!(yield* fs.isFile(resolved))) {
      return yield* new UnavailableError({
        code: codes.missing,
        message: `the managed worktree-store file does not exist: ${resolved}.`,
      })
    }
    const realFile = yield* fs.resolve(resolved)
    if (!FSUtil.contains(root, realFile)) {
      return yield* new UnavailableError({
        code: codes.escape,
        message: `the managed worktree-store file resolves outside the stage root: ${candidate}.`,
      })
    }
    return realFile
  })
}

function candidateRelative(candidate: string, code: string): string {
  const normalized = candidate.replace(/\\/g, "/").replace(/^\/+/, "")
  return assertBundleRelativePath(normalized, "managed worktree-store path", code)
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [FSUtil.node, ManagedWorktreeManager.node],
})

export * as ManagedWorktreeCapability from "./capability"
