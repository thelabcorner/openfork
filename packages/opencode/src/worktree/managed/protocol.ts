import path from "node:path"
import { Schema } from "effect"

export const MANAGED_PROTOCOL_VERSION = 1

export const MANAGED_PROTOCOL_COMMANDS = ["protocol-version", "managed-create-initialize", "managed-status"] as const

export type ManagedProtocolCommand = (typeof MANAGED_PROTOCOL_COMMANDS)[number]

export function isManagedProtocolCommand(value: string): value is ManagedProtocolCommand {
  return (MANAGED_PROTOCOL_COMMANDS as readonly string[]).includes(value)
}

export const MANAGED_EXIT_SUCCESS = 0
export const MANAGED_EXIT_INVALID_REQUEST = 2
export const MANAGED_EXIT_CONTENTION_RETRYABLE = 3
export const MANAGED_EXIT_RECONCILE_QUARANTINE_FATAL = 4
export const MANAGED_EXIT_INTERNAL_DEFECT = 5

export const MANAGED_EXIT_CODES = Object.freeze({
  success: MANAGED_EXIT_SUCCESS,
  invalidRequest: MANAGED_EXIT_INVALID_REQUEST,
  contentionRetryable: MANAGED_EXIT_CONTENTION_RETRYABLE,
  reconcileQuarantineFatal: MANAGED_EXIT_RECONCILE_QUARANTINE_FATAL,
  internalDefect: MANAGED_EXIT_INTERNAL_DEFECT,
})

export type ManagedErrorCategory = "invalid-request" | "contention" | "reconcile-required" | "internal"

const CATEGORY_EXIT_CODES: Readonly<Record<ManagedErrorCategory, number>> = Object.freeze({
  "invalid-request": MANAGED_EXIT_INVALID_REQUEST,
  contention: MANAGED_EXIT_CONTENTION_RETRYABLE,
  "reconcile-required": MANAGED_EXIT_RECONCILE_QUARANTINE_FATAL,
  internal: MANAGED_EXIT_INTERNAL_DEFECT,
})

export function exitCodeForCategory(category: ManagedErrorCategory): number {
  return CATEGORY_EXIT_CODES[category]
}

export function categoryForExitCode(exitCode: number): ManagedErrorCategory | undefined {
  switch (exitCode) {
    case MANAGED_EXIT_INVALID_REQUEST:
      return "invalid-request"
    case MANAGED_EXIT_CONTENTION_RETRYABLE:
      return "contention"
    case MANAGED_EXIT_RECONCILE_QUARANTINE_FATAL:
      return "reconcile-required"
    case MANAGED_EXIT_INTERNAL_DEFECT:
      return "internal"
    default:
      return undefined
  }
}

export const MANAGED_ERROR_CODES = Object.freeze({
  protocolJsonInvalid: "PROTOCOL_JSON_INVALID",
  protocolUsage: "PROTOCOL_USAGE",
  protocolVersionUnsupported: "PROTOCOL_VERSION_UNSUPPORTED",
  commandUnsupported: "COMMAND_UNSUPPORTED",
  requestInvalid: "REQUEST_INVALID",
  controlPlaneUnavailable: "CONTROL_PLANE_UNAVAILABLE",
  repositoryNotRegistered: "REPOSITORY_NOT_REGISTERED",
  storageVolumeNotRegistered: "STORAGE_VOLUME_NOT_REGISTERED",
  worktreeNotFound: "WORKTREE_NOT_FOUND",
  worktreeIdentityConflict: "WORKTREE_IDENTITY_CONFLICT",
  worktreeStateConflict: "WORKTREE_STATE_CONFLICT",
  fenceAdapterUnavailable: "FENCE_ADAPTER_UNAVAILABLE",
  coordinatorContention: "COORDINATOR_CONTENTION",
  contentionRetryable: "CONTENTION_RETRYABLE",
  fatalFailure: "FATAL_FAILURE",
  internalDefect: "INTERNAL_DEFECT",
})

export const MANAGED_ERROR_CODE_SET: ReadonlySet<string> = new Set(Object.values(MANAGED_ERROR_CODES))

export const MANAGED_INVOCATION_ERROR_CODES: ReadonlySet<string> = new Set([
  MANAGED_ERROR_CODES.protocolJsonInvalid,
  MANAGED_ERROR_CODES.protocolUsage,
  MANAGED_ERROR_CODES.requestInvalid,
])

export const MANAGED_DOMAIN_REFUSAL_CODES: ReadonlySet<string> = new Set([
  MANAGED_ERROR_CODES.repositoryNotRegistered,
  MANAGED_ERROR_CODES.storageVolumeNotRegistered,
  MANAGED_ERROR_CODES.worktreeNotFound,
  MANAGED_ERROR_CODES.worktreeIdentityConflict,
])

export const MANAGED_PROTOCOL_MISMATCH_CODES: ReadonlySet<string> = new Set([
  MANAGED_ERROR_CODES.protocolVersionUnsupported,
  MANAGED_ERROR_CODES.commandUnsupported,
])

export const MANAGED_LIMITS = Object.freeze({
  maxIdLength: 256,
  maxPathLength: 4096,
  maxNameLength: 1024,
  maxMessageLength: 2000,
  maxErrorMessageLength: 4096,
  maxCodeLength: 128,
  maxArgs: 64,
  maxArgLength: 4096,
  maxStdoutBytes: 2 * 1024 * 1024,
  maxStderrBytes: 16 * 1024,
  maxRequestBytes: 2 * 1024 * 1024,
  maxEvidenceItems: 64,
  maxEvidenceTextLength: 4096,
  maxOpaqueBytes: 512 * 1024,
  maxHandshakeTextLength: 512,
  maxCommands: 64,
})

export class ManagedWireViolation extends Schema.TaggedErrorClass<ManagedWireViolation>()("ManagedWorktreeWireViolation", {
  code: Schema.String,
  message: Schema.String,
}) {}

export class ManagedRequestInvalid extends Schema.TaggedErrorClass<ManagedRequestInvalid>()(
  "ManagedWorktreeRequestInvalid",
  {
    code: Schema.String,
    message: Schema.String,
  },
) {}

class Violation extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "ManagedWireViolation"
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new Violation(code, message)
}

function invalid(message: string): never {
  fail(MANAGED_ERROR_CODES.requestInvalid, message)
}

function asWire<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof Violation) throw new ManagedWireViolation({ code: error.code, message: error.message })
    throw error
  }
}

function asRequest<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof Violation) throw new ManagedRequestInvalid({ code: error.code, message: error.message })
    throw error
  }
}

export function boundedExcerpt(value: string, maxLength = 512): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${at} must be a JSON object.`)
  return value
}

function rejectUnknownKeys(object: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) invalid(`${at}.${key} is not a recognized field.`)
  }
}

function requireString(
  object: Record<string, unknown>,
  key: string,
  at: string,
  maxLength: number = MANAGED_LIMITS.maxIdLength,
): string {
  const value = object[key]
  if (typeof value !== "string" || value.length === 0) invalid(`${at}.${key} must be a non-empty string.`)
  if (value.length > maxLength) invalid(`${at}.${key} exceeds the maximum length of ${maxLength}.`)
  if (/[\u0000-\u001f\u007f]/.test(value)) invalid(`${at}.${key} must not contain control characters.`)
  return value
}

function optionalString(
  object: Record<string, unknown>,
  key: string,
  at: string,
  maxLength: number = MANAGED_LIMITS.maxIdLength,
): string | undefined {
  if (object[key] === undefined) return undefined
  return requireString(object, key, at, maxLength)
}

function requireNullableString(
  object: Record<string, unknown>,
  key: string,
  at: string,
  maxLength: number = MANAGED_LIMITS.maxIdLength,
): string | null {
  if (object[key] === null) return null
  return requireString(object, key, at, maxLength)
}

function requireAbsoluteWindowsPath(object: Record<string, unknown>, key: string, at: string): string {
  const value = requireString(object, key, at, MANAGED_LIMITS.maxPathLength)
  if (!path.win32.isAbsolute(value)) invalid(`${at}.${key} must be an absolute Windows path.`)
  return value
}

function requireBoolean(object: Record<string, unknown>, key: string, at: string): boolean {
  const value = object[key]
  if (typeof value !== "boolean") invalid(`${at}.${key} must be boolean.`)
  return value
}

function requireInteger(
  object: Record<string, unknown>,
  key: string,
  at: string,
  minimum: number,
  maximum: number,
): number {
  const value = object[key]
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${at}.${key} must be an integer from ${minimum} to ${maximum}.`)
  }
  return value
}

function requireOptionalInteger(
  object: Record<string, unknown>,
  key: string,
  at: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (object[key] === undefined) return undefined
  return requireInteger(object, key, at, minimum, maximum)
}

function requireNullableInteger(
  object: Record<string, unknown>,
  key: string,
  at: string,
  minimum: number,
  maximum: number,
): number | null {
  if (object[key] === null) return null
  return requireInteger(object, key, at, minimum, maximum)
}

function requireRatio(object: Record<string, unknown>, key: string, at: string): number {
  const value = object[key]
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid(`${at}.${key} must be a number from 0 to 1.`)
  }
  return value
}

function requireStringArray(
  object: Record<string, unknown>,
  key: string,
  at: string,
  options: { minItems: number; maxItems: number; maxItemLength: number },
): readonly string[] {
  const value = object[key]
  if (!Array.isArray(value)) invalid(`${at}.${key} must be an array of strings.`)
  if (value.length < options.minItems || value.length > options.maxItems) {
    invalid(`${at}.${key} must contain ${options.minItems} to ${options.maxItems} entries.`)
  }
  const result: string[] = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.length === 0) invalid(`${at}.${key}[${index}] must be a non-empty string.`)
    if (entry.length > options.maxItemLength) {
      invalid(`${at}.${key}[${index}] exceeds the maximum length of ${options.maxItemLength}.`)
    }
    if (/[\u0000-\u001f\u007f]/.test(entry)) invalid(`${at}.${key}[${index}] must not contain control characters.`)
    result.push(entry)
  }
  return result
}

function optionalStringArray(object: Record<string, unknown>, key: string, at: string): readonly string[] | undefined {
  if (object[key] === undefined) return undefined
  return requireStringArray(object, key, at, {
    minItems: 0,
    maxItems: MANAGED_LIMITS.maxArgs,
    maxItemLength: MANAGED_LIMITS.maxArgLength,
  })
}

function requireBoundedJson(object: Record<string, unknown>, key: string, at: string): unknown {
  const value = object[key]
  if (value === undefined) return undefined
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    invalid(`${at}.${key} must be JSON-serializable.`)
  }
  if (serialized === undefined) invalid(`${at}.${key} must be JSON-serializable.`)
  if (Buffer.byteLength(serialized, "utf8") > MANAGED_LIMITS.maxOpaqueBytes) {
    invalid(`${at}.${key} exceeds the maximum opaque size of ${MANAGED_LIMITS.maxOpaqueBytes} bytes.`)
  }
  return value
}

function requireId(object: Record<string, unknown>, key: string, at: string): string {
  return requireString(object, key, at, MANAGED_LIMITS.maxIdLength)
}

function requireGovernedId(value: string, at: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) invalid(`${at} is outside the accepted identifier format.`)
  return value
}

export interface ManagedStoragePolicyRequest {
  readonly managedRootPath: string
  readonly acceptedVolumeGuids: readonly string[]
  readonly expectedPartitionGuid: string
  readonly expectedDiskGuid: string
  readonly expectedBackingPath: string
  readonly expectedFilesystem: string
  readonly expectedLabel?: string
  readonly requireBlockCloning: boolean
  readonly requireDevDrive: boolean
  readonly requireTrustedDevDrive: boolean
  readonly minimumVolumeFreeBytes: number
  readonly minimumVolumeFreeRatio: number
  readonly minimumHostFreeBytes: number
  readonly minimumHostFreeRatio: number
}

export interface ManagedStorageProbeRequest {
  readonly helperPath: string
  readonly helperArgsPrefix?: readonly string[]
}

export interface ManagedDedupeRequest {
  readonly nativeHelperPath: string
  readonly nativeHelperArgsPrefix?: readonly string[]
  readonly minimumCandidateBytes: number
  readonly concurrency?: number
  readonly tempParent?: string
}

export interface ManagedCreateInitializeRequest {
  readonly worktreeId: string
  readonly repositoryId: string
  readonly repositoryPath?: string
  readonly storageVolumeId: string
  readonly targetPath: string
  readonly branchName: string
  readonly commitish: string
  readonly storagePolicy: ManagedStoragePolicyRequest
  readonly storageProbe: ManagedStorageProbeRequest
  readonly dedupe: ManagedDedupeRequest
}

export interface ManagedStatusRequest {
  readonly worktreeId: string
}

export interface ManagedProtocolVersionRequestDocument {
  readonly protocolVersion: typeof MANAGED_PROTOCOL_VERSION
  readonly command: "protocol-version"
}

export interface ManagedStatusRequestDocument {
  readonly protocolVersion: typeof MANAGED_PROTOCOL_VERSION
  readonly command: "managed-status"
  readonly worktreeId: string
}

export interface ManagedCreateInitializeRequestDocument {
  readonly protocolVersion: typeof MANAGED_PROTOCOL_VERSION
  readonly command: "managed-create-initialize"
  readonly worktreeId: string
  readonly repositoryId: string
  readonly repositoryPath?: string
  readonly storageVolumeId: string
  readonly targetPath: string
  readonly branchName: string
  readonly commitish: string
  readonly storagePolicy: ManagedStoragePolicyRequest
  readonly storageProbe: ManagedStorageProbeRequest
  readonly dedupe: ManagedDedupeRequest
}

export type ManagedRequestDocument =
  | ManagedProtocolVersionRequestDocument
  | ManagedStatusRequestDocument
  | ManagedCreateInitializeRequestDocument

function parseStoragePolicy(value: unknown, at: string): ManagedStoragePolicyRequest {
  const object = requireRecord(value, at)
  rejectUnknownKeys(
    object,
    [
      "managedRootPath",
      "acceptedVolumeGuids",
      "expectedPartitionGuid",
      "expectedDiskGuid",
      "expectedBackingPath",
      "expectedFilesystem",
      "expectedLabel",
      "requireBlockCloning",
      "requireDevDrive",
      "requireTrustedDevDrive",
      "minimumVolumeFreeBytes",
      "minimumVolumeFreeRatio",
      "minimumHostFreeBytes",
      "minimumHostFreeRatio",
    ],
    at,
  )
  const expectedLabel = optionalString(object, "expectedLabel", at, MANAGED_LIMITS.maxNameLength)
  return Object.freeze({
    managedRootPath: requireAbsoluteWindowsPath(object, "managedRootPath", at),
    acceptedVolumeGuids: requireStringArray(object, "acceptedVolumeGuids", at, {
      minItems: 1,
      maxItems: 16,
      maxItemLength: MANAGED_LIMITS.maxPathLength,
    }),
    expectedPartitionGuid: requireString(object, "expectedPartitionGuid", at, MANAGED_LIMITS.maxNameLength),
    expectedDiskGuid: requireString(object, "expectedDiskGuid", at, MANAGED_LIMITS.maxNameLength),
    expectedBackingPath: requireString(object, "expectedBackingPath", at, MANAGED_LIMITS.maxPathLength),
    expectedFilesystem: requireString(object, "expectedFilesystem", at, MANAGED_LIMITS.maxNameLength),
    ...(expectedLabel === undefined ? {} : { expectedLabel }),
    requireBlockCloning: requireBoolean(object, "requireBlockCloning", at),
    requireDevDrive: requireBoolean(object, "requireDevDrive", at),
    requireTrustedDevDrive: requireBoolean(object, "requireTrustedDevDrive", at),
    minimumVolumeFreeBytes: requireInteger(object, "minimumVolumeFreeBytes", at, 0, Number.MAX_SAFE_INTEGER),
    minimumVolumeFreeRatio: requireRatio(object, "minimumVolumeFreeRatio", at),
    minimumHostFreeBytes: requireInteger(object, "minimumHostFreeBytes", at, 0, Number.MAX_SAFE_INTEGER),
    minimumHostFreeRatio: requireRatio(object, "minimumHostFreeRatio", at),
  })
}

function parseStorageProbe(value: unknown, at: string): ManagedStorageProbeRequest {
  const object = requireRecord(value, at)
  rejectUnknownKeys(object, ["helperPath", "helperArgsPrefix"], at)
  const helperArgsPrefix = optionalStringArray(object, "helperArgsPrefix", at)
  return Object.freeze({
    helperPath: requireString(object, "helperPath", at, MANAGED_LIMITS.maxPathLength),
    ...(helperArgsPrefix === undefined ? {} : { helperArgsPrefix }),
  })
}

function parseDedupe(value: unknown, at: string): ManagedDedupeRequest {
  const object = requireRecord(value, at)
  rejectUnknownKeys(
    object,
    ["nativeHelperPath", "nativeHelperArgsPrefix", "minimumCandidateBytes", "concurrency", "tempParent"],
    at,
  )
  const nativeHelperArgsPrefix = optionalStringArray(object, "nativeHelperArgsPrefix", at)
  const concurrency = requireOptionalInteger(object, "concurrency", at, 1, 64)
  const tempParent = optionalString(object, "tempParent", at, MANAGED_LIMITS.maxPathLength)
  return Object.freeze({
    nativeHelperPath: requireString(object, "nativeHelperPath", at, MANAGED_LIMITS.maxPathLength),
    ...(nativeHelperArgsPrefix === undefined ? {} : { nativeHelperArgsPrefix }),
    minimumCandidateBytes: requireInteger(object, "minimumCandidateBytes", at, 1, Number.MAX_SAFE_INTEGER),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(tempParent === undefined ? {} : { tempParent }),
  })
}

function parseCreateInitializeFields(document: Record<string, unknown>, at: string): ManagedCreateInitializeRequest {
  rejectUnknownKeys(
    document,
    [
      "protocolVersion",
      "command",
      "worktreeId",
      "repositoryId",
      "repositoryPath",
      "storageVolumeId",
      "targetPath",
      "branchName",
      "commitish",
      "storagePolicy",
      "storageProbe",
      "dedupe",
    ],
    at,
  )
  const repositoryPath = optionalString(document, "repositoryPath", at, MANAGED_LIMITS.maxPathLength)
  if (repositoryPath !== undefined && !path.win32.isAbsolute(repositoryPath)) {
    invalid(`${at}.repositoryPath must be an absolute Windows path when provided.`)
  }
  return Object.freeze({
    worktreeId: requireGovernedId(requireId(document, "worktreeId", at), `${at}.worktreeId`),
    repositoryId: requireGovernedId(requireId(document, "repositoryId", at), `${at}.repositoryId`),
    ...(repositoryPath === undefined ? {} : { repositoryPath }),
    storageVolumeId: requireGovernedId(requireId(document, "storageVolumeId", at), `${at}.storageVolumeId`),
    targetPath: requireAbsoluteWindowsPath(document, "targetPath", at),
    branchName: requireString(document, "branchName", at, MANAGED_LIMITS.maxNameLength),
    commitish: requireString(document, "commitish", at, MANAGED_LIMITS.maxNameLength),
    storagePolicy: parseStoragePolicy(document.storagePolicy, `${at}.storagePolicy`),
    storageProbe: parseStorageProbe(document.storageProbe, `${at}.storageProbe`),
    dedupe: parseDedupe(document.dedupe, `${at}.dedupe`),
  })
}

export function managedProtocolVersionRequestDocument(): ManagedProtocolVersionRequestDocument {
  return Object.freeze({
    protocolVersion: MANAGED_PROTOCOL_VERSION,
    command: "protocol-version" as const,
  })
}

export function managedStatusRequestDocument(worktreeId: string): ManagedStatusRequestDocument {
  return asRequest(() =>
    Object.freeze({
      protocolVersion: MANAGED_PROTOCOL_VERSION,
      command: "managed-status" as const,
      worktreeId: requireGovernedId(
        requireString({ worktreeId }, "worktreeId", "request", MANAGED_LIMITS.maxIdLength),
        "request.worktreeId",
      ),
    }),
  )
}

export function managedCreateInitializeRequestDocument(
  request: ManagedCreateInitializeRequest,
): ManagedCreateInitializeRequestDocument {
  return asRequest(() => {
    const fields = parseCreateInitializeFields({ ...request }, "request")
    return Object.freeze({
      protocolVersion: MANAGED_PROTOCOL_VERSION,
      command: "managed-create-initialize" as const,
      ...fields,
    })
  })
}

export interface ManagedSuccessResponse {
  readonly protocolVersion: typeof MANAGED_PROTOCOL_VERSION
  readonly ok: true
  readonly command: ManagedProtocolCommand
  readonly result: unknown
}

export interface ManagedErrorPayload {
  readonly code: string
  readonly category: ManagedErrorCategory
  readonly retryable: boolean
  readonly message: string
  readonly worktreeId?: string
  readonly operationId?: string
  readonly reconcileRequired?: boolean
  readonly quarantine?: unknown
  readonly state?: unknown
}

export interface ManagedErrorResponse {
  readonly protocolVersion: typeof MANAGED_PROTOCOL_VERSION
  readonly ok: false
  readonly command: string
  readonly error: ManagedErrorPayload
}

export type ManagedResponse = ManagedSuccessResponse | ManagedErrorResponse

/**
 * The frozen worktree-store fence-adapter capability.
 *
 * Current worktree-store builds advertise a strict object naming the wired
 * adapter. Older builds advertised a bare token string; that shape is still
 * parsed for compatibility, but can never be fence-ready because it does not
 * prove which adapter is wired.
 */
export interface ManagedFenceAdapterCapability {
  readonly status: string
  readonly adapter: string | null
  readonly requiresActivityFenceConfig: boolean | null
  readonly requiresOpenForkDiscoveryDirectory: boolean | null
  readonly connectsOnlyWhenDonorRequiresExclusion: boolean | null
  readonly missingConfigurationFailsClosedWhenDonorRequired: boolean | null
  /** True only for the exact wired adapter contract this client speaks. */
  readonly fenceReady: boolean
}

export const MANAGED_FENCE_ADAPTER_NAME = "openfork-http-directory-activity-fence"

/**
 * The managed path may only be activated when the sidecar proves that a real
 * activity-fence adapter is wired and fails closed without its configuration.
 * Anything unknown is not ready.
 */
export function managedFenceAdapterReady(capabilities: ManagedProtocolCapabilities): boolean {
  return capabilities.managedCreateInitialize.dedupeFenceAdapter.fenceReady
}

export interface ManagedProtocolCapabilities {
  readonly protocolVersion: { readonly opensControlPlaneDatabase: boolean }
  readonly managedCreateInitialize: {
    readonly acquiresSingleWriterCoordinator: boolean
    readonly completesOnlyAtExactIdleClean: boolean
    readonly requiresRegisteredRepository: boolean
    readonly requiresRegisteredStorageVolume: boolean
    readonly requiresExplicitStorageIdentity: boolean
    readonly requiresNativeStorageProbeHelper: boolean
    readonly requiresNativeDedupeHelper: boolean
    readonly dedupeFenceAdapter: ManagedFenceAdapterCapability
    readonly neverFallsBackToUnmanagedGit: boolean
  }
  readonly managedStatus: {
    readonly readOnly: boolean
    readonly acquiresSingleWriterCoordinator: boolean
    readonly liveGitLockEvidence: boolean
  }
  readonly additions: Readonly<Record<string, unknown>>
}

export interface ManagedProtocolVersionResult {
  readonly managedProtocolVersion: typeof MANAGED_PROTOCOL_VERSION
  readonly packageName: string
  readonly packageVersion: string
  readonly runtime: {
    readonly bun: string
    readonly platform: string
    readonly arch: string
    readonly pid: number
  }
  readonly commands: readonly string[]
  readonly exitCodes: typeof MANAGED_EXIT_CODES
  readonly capabilities: ManagedProtocolCapabilities
  readonly prerequisites: readonly string[]
}

export interface ManagedRepositoryEvidence {
  readonly id: string
  readonly canonicalTopLevel: string
  readonly gitCommonDir: string
  readonly objectFormat: string
  readonly identityMethod: string
  readonly createdAt: string
  readonly lastSeenAt: string
}

export interface ManagedStorageVolumeEvidence {
  readonly id: string
  readonly role: string
  readonly state: string
  readonly volumeGuid: string | null
  readonly label: string | null
  readonly filesystem: string | null
  readonly backingPath: string | null
  readonly lastVerifiedAt: string | null
}

export interface ManagedWorktreeRow {
  readonly repositoryId: string
  readonly storageVolumeId: string | null
  readonly path: string
  readonly pathKey: string
  readonly ownership: string
  readonly head: string
  readonly branchRef: string | null
  readonly pinRef: string | null
  readonly durabilityClass: string
  readonly lifecycleState: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ManagedOperationEvidence {
  readonly operationId: string
  readonly kind: string
  readonly state: string
  readonly expectedRevision: number | null
  readonly startedAt: string
  readonly completedAt: string | null
  readonly errorCode: string | null
  readonly detailJson: string | null
}

export interface ManagedGuardAttemptEvidence {
  readonly attemptId: string
  readonly guardId: string
  readonly operationId: string
  readonly donorWorktreeId: string
  readonly targetWorktreeId: string
  readonly donorRevision: number
  readonly targetRevision: number
  readonly state: string
  readonly externalOwnerId: string | null
  readonly externalAcquisitionId: string | null
  readonly externalGeneration: number | null
  readonly createdAt: string
  readonly acquiredAt: string | null
  readonly releasedAt: string | null
  readonly updatedAt: string
}

export interface ManagedActivityClaimEvidence {
  readonly sessionId: string
  readonly runtimeOwnerId: string
  readonly agentId: string | null
  readonly executionGeneration: number
  readonly state: string
  readonly acquiredAt: string
  readonly lastAuthoritativeActivityAt: string
  readonly releasedAt: string | null
  readonly updatedAt: string
}

export interface ManagedMaintenanceGuardEvidence {
  readonly guardId: string
  readonly attemptId: string
  readonly operationId: string | null
  readonly generation: number
  readonly state: string
  readonly acquiredAt: string
  readonly releasedAt: string | null
  readonly updatedAt: string
}

export interface ManagedGitEvidence {
  readonly probe: "ok" | "unavailable" | "error"
  readonly repositoryPath: string
  readonly worktreePath: string
  readonly registered: boolean | null
  readonly locked: boolean | null
  readonly lockReason: string | null
  readonly head: string | null
  readonly branchRef: string | null
  readonly bare: boolean | null
  readonly detached: boolean | null
  readonly prunable: boolean | null
  readonly unknownAttributes: readonly string[]
  readonly error: string | null
}

export interface ManagedStatusResult {
  readonly worktreeId: string
  readonly repository: ManagedRepositoryEvidence
  readonly storageVolume: ManagedStorageVolumeEvidence | null
  readonly worktree: ManagedWorktreeRow
  readonly revision: {
    readonly actual: number
    readonly openOperationExpectedRevisions: readonly {
      readonly operationId: string
      readonly expectedRevision: number | null
    }[]
  }
  readonly quarantine: {
    readonly quarantined: boolean
    readonly lifecycleState: string
    readonly durabilityClass: string
  } | null
  readonly handoff: {
    readonly reconcileRequired: boolean
    readonly reasons: readonly string[]
    readonly openOperationCount: number
    readonly unresolvedGuardAttemptCount: number
    readonly reconcileRequiredGuardAttemptCount: number
    readonly reconcileRequiredActivityClaimCount: number
    readonly reconcileRequiredMaintenanceGuardCount: number
  }
  readonly operations: {
    readonly open: readonly ManagedOperationEvidence[]
    readonly latest: readonly ManagedOperationEvidence[]
  }
  readonly guardAttempts: readonly ManagedGuardAttemptEvidence[]
  readonly activityClaims: readonly ManagedActivityClaimEvidence[]
  readonly maintenanceGuards: readonly ManagedMaintenanceGuardEvidence[]
  readonly gitEvidence: ManagedGitEvidence
}

export interface ManagedCreateInitializeResult {
  readonly worktreeId: string
  readonly repositoryId: string
  readonly storageVolumeId: string
  readonly targetPath: string
  readonly pathKey: string
  readonly ownership: string
  readonly lifecycleState: string
  readonly durabilityClass: string
  readonly revision: number
  readonly head: string
  readonly branchRef: string | null
  readonly pinRef: string | null
  readonly createOperationId: string | null
  readonly initializationOperationId: string | null
  readonly summary: unknown
  readonly idempotent: boolean
}

function requireBoundedText(object: Record<string, unknown>, key: string, at: string): string {
  return requireString(object, key, at, MANAGED_LIMITS.maxEvidenceTextLength)
}

function parseErrorPayload(value: unknown): ManagedErrorPayload {
  const at = "response.error"
  const object = requireRecord(value, at)
  rejectUnknownKeys(
    object,
    ["code", "category", "retryable", "message", "worktreeId", "operationId", "reconcileRequired", "quarantine", "state"],
    at,
  )
  const code = requireString(object, "code", at, MANAGED_LIMITS.maxCodeLength)
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(code)) invalid(`${at}.code is outside the accepted code format.`)
  const category = object.category
  if (
    category !== "invalid-request" &&
    category !== "contention" &&
    category !== "reconcile-required" &&
    category !== "internal"
  ) {
    invalid(`${at}.category must be one of: invalid-request, contention, reconcile-required, internal.`)
  }
  const retryable = requireBoolean(object, "retryable", at)
  if (retryable !== (category === "contention")) {
    invalid(`${at}.retryable must be ${category === "contention"} for category ${category}.`)
  }
  const message = requireString(object, "message", at, MANAGED_LIMITS.maxErrorMessageLength)
  const worktreeId = optionalString(object, "worktreeId", at, MANAGED_LIMITS.maxIdLength)
  const operationId = optionalString(object, "operationId", at, MANAGED_LIMITS.maxIdLength)
  const reconcileRequired =
    object.reconcileRequired === undefined ? undefined : requireBoolean(object, "reconcileRequired", at)
  const quarantine = requireBoundedJson(object, "quarantine", at)
  const state = requireBoundedJson(object, "state", at)
  return Object.freeze({
    code,
    category,
    retryable,
    message,
    ...(worktreeId === undefined ? {} : { worktreeId }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(reconcileRequired === undefined ? {} : { reconcileRequired }),
    ...(quarantine === undefined ? {} : { quarantine }),
    ...(state === undefined ? {} : { state }),
  })
}

export function parseManagedResponseDocument(value: unknown): ManagedResponse {
  return asWire(() => parseManagedResponseDocumentUnsafe(value))
}

function parseManagedResponseDocumentUnsafe(value: unknown): ManagedResponse {
  const at = "response"
  const document = requireRecord(value, at)
  if (document.protocolVersion !== MANAGED_PROTOCOL_VERSION) {
    fail(
      document.protocolVersion === undefined
        ? MANAGED_ERROR_CODES.protocolJsonInvalid
        : MANAGED_ERROR_CODES.protocolVersionUnsupported,
      `${at}.protocolVersion must be ${MANAGED_PROTOCOL_VERSION}.`,
    )
  }
  if (typeof document.ok !== "boolean") invalid(`${at}.ok must be boolean.`)
  const command = requireString(document, "command", at, 64)
  if (!isManagedProtocolCommand(command)) {
    fail(MANAGED_ERROR_CODES.commandUnsupported, `${at}.command must be one of: ${MANAGED_PROTOCOL_COMMANDS.join(", ")}.`)
  }

  if (document.ok) {
    rejectUnknownKeys(document, ["protocolVersion", "ok", "command", "result"], at)
    if (!("result" in document)) invalid(`${at}.result is required for a success response.`)
    return Object.freeze({
      protocolVersion: MANAGED_PROTOCOL_VERSION,
      ok: true as const,
      command,
      result: document.result,
    })
  }

  rejectUnknownKeys(document, ["protocolVersion", "ok", "command", "error"], at)
  if (!("error" in document)) invalid(`${at}.error is required for an error response.`)
  return Object.freeze({
    protocolVersion: MANAGED_PROTOCOL_VERSION,
    ok: false as const,
    command,
    error: parseErrorPayload(document.error),
  })
}

export function parseManagedResponseText(text: string): ManagedResponse {
  return asWire(() => parseManagedResponseDocumentUnsafe(parseJsonDocument(text)))
}

function parseJsonDocument(text: string): unknown {
  if (typeof text !== "string" || text.length === 0) {
    fail(MANAGED_ERROR_CODES.protocolJsonInvalid, "stdout must contain exactly one JSON document.")
  }
  if (text.charCodeAt(0) === 0xfeff) fail(MANAGED_ERROR_CODES.protocolJsonInvalid, "stdout must not start with a BOM.")
  if (Buffer.byteLength(text, "utf8") > MANAGED_LIMITS.maxStdoutBytes) {
    fail(MANAGED_ERROR_CODES.protocolJsonInvalid, `stdout exceeds ${MANAGED_LIMITS.maxStdoutBytes} bytes.`)
  }
  const trimmed = text.trim()
  if (trimmed.length === 0) fail(MANAGED_ERROR_CODES.protocolJsonInvalid, "stdout must not be empty.")
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    fail(MANAGED_ERROR_CODES.protocolJsonInvalid, "stdout is not a single valid JSON document.")
  }
}

export interface ManagedExitOutcome {
  readonly response: ManagedResponse
  readonly category: ManagedErrorCategory | undefined
  readonly retryable: boolean
}

export function parseManagedExitOutcome(
  input: { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
  expected: { readonly command: ManagedProtocolCommand },
): ManagedExitOutcome {
  return asWire(() => {
    const succeeded = input.exitCode === MANAGED_EXIT_SUCCESS
    const category = succeeded ? undefined : categoryForExitCode(input.exitCode)
    if (!succeeded && category === undefined) {
      fail(MANAGED_ERROR_CODES.protocolJsonInvalid, `exit code ${input.exitCode} is not a managed protocol exit code.`)
    }
    const response = parseManagedResponseDocumentUnsafe(parseJsonDocument(input.stdout))
    if (response.command !== expected.command) {
      fail(
        MANAGED_ERROR_CODES.commandUnsupported,
        `response.command ${response.command} does not match invoked command ${expected.command}.`,
      )
    }
    if (succeeded) {
      if (!response.ok) {
        fail(MANAGED_ERROR_CODES.fatalFailure, "exit code 0 carried an error response.")
      }
      return Object.freeze({ response, category: undefined, retryable: false })
    }
    if (response.ok) {
      fail(MANAGED_ERROR_CODES.fatalFailure, `exit code ${input.exitCode} carried a success response.`)
    }
    if (response.error.category !== category) {
      fail(
        MANAGED_ERROR_CODES.fatalFailure,
        `exit code ${input.exitCode} requires category ${category}; error carried ${response.error.category}.`,
      )
    }
    return Object.freeze({ response, category, retryable: response.error.retryable })
  })
}

function parseRuntime(value: unknown, at: string): ManagedProtocolVersionResult["runtime"] {
  const object = requireRecord(value, at)
  rejectUnknownKeys(object, ["bun", "platform", "arch", "pid"], at)
  return Object.freeze({
    bun: requireString(object, "bun", at, MANAGED_LIMITS.maxHandshakeTextLength),
    platform: requireString(object, "platform", at, MANAGED_LIMITS.maxHandshakeTextLength),
    arch: requireString(object, "arch", at, MANAGED_LIMITS.maxHandshakeTextLength),
    pid: requireInteger(object, "pid", at, 0, Number.MAX_SAFE_INTEGER),
  })
}

function parseCapabilityFlags(
  value: unknown,
  at: string,
  requiredBooleans: readonly string[],
): Record<string, boolean | string> {
  const object = requireRecord(value, at)
  const result: Record<string, boolean | string> = {}
  for (const key of requiredBooleans) {
    result[key] = requireBoolean(object, key, at)
  }
  return result
}

const FENCE_ADAPTER_KEYS = [
  "status",
  "adapter",
  "requiresActivityFenceConfig",
  "requiresOpenForkDiscoveryDirectory",
  "connectsOnlyWhenDonorRequiresExclusion",
  "missingConfigurationFailsClosedWhenDonorRequired",
] as const

const FENCE_ADAPTER_STATUS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

/**
 * Strict parser for the fence-adapter capability.
 *
 * The object form is exact-key: an unknown field is a wire violation rather
 * than a silently ignored extension, because this value gates managed
 * activation. `fenceReady` additionally requires every fail-closed guarantee
 * to be explicitly true, so a partially-described adapter is never treated as
 * ready.
 */
function parseFenceAdapterCapability(value: unknown, at: string): ManagedFenceAdapterCapability {
  if (typeof value === "string") {
    if (value.length === 0 || value.length > MANAGED_LIMITS.maxNameLength) {
      invalid(`${at} must be a bounded non-empty token.`)
    }
    if (!FENCE_ADAPTER_STATUS_PATTERN.test(value)) invalid(`${at} is outside the accepted token format.`)
    return Object.freeze({
      status: value,
      adapter: null,
      requiresActivityFenceConfig: null,
      requiresOpenForkDiscoveryDirectory: null,
      connectsOnlyWhenDonorRequiresExclusion: null,
      missingConfigurationFailsClosedWhenDonorRequired: null,
      fenceReady: false,
    })
  }
  const object = requireRecord(value, at)
  rejectUnknownKeys(object, FENCE_ADAPTER_KEYS, at)
  const status = requireString(object, "status", at, MANAGED_LIMITS.maxNameLength)
  if (!FENCE_ADAPTER_STATUS_PATTERN.test(status)) invalid(`${at}.status is outside the accepted token format.`)
  const adapter = requireString(object, "adapter", at, MANAGED_LIMITS.maxNameLength)
  const requiresActivityFenceConfig = requireBoolean(object, "requiresActivityFenceConfig", at)
  const requiresOpenForkDiscoveryDirectory = requireBoolean(object, "requiresOpenForkDiscoveryDirectory", at)
  const connectsOnlyWhenDonorRequiresExclusion = requireBoolean(object, "connectsOnlyWhenDonorRequiresExclusion", at)
  const missingConfigurationFailsClosedWhenDonorRequired = requireBoolean(
    object,
    "missingConfigurationFailsClosedWhenDonorRequired",
    at,
  )
  return Object.freeze({
    status,
    adapter,
    requiresActivityFenceConfig,
    requiresOpenForkDiscoveryDirectory,
    connectsOnlyWhenDonorRequiresExclusion,
    missingConfigurationFailsClosedWhenDonorRequired,
    fenceReady:
      status === "wired" &&
      adapter === MANAGED_FENCE_ADAPTER_NAME &&
      requiresActivityFenceConfig &&
      requiresOpenForkDiscoveryDirectory &&
      connectsOnlyWhenDonorRequiresExclusion &&
      missingConfigurationFailsClosedWhenDonorRequired,
  })
}

function parseCapabilities(value: unknown): ManagedProtocolCapabilities {
  const at = "result.capabilities"
  const object = requireRecord(value, at)
  const protocolVersionAt = `${at}.protocolVersion`
  const protocolVersionObject = requireRecord(object.protocolVersion, protocolVersionAt)
  rejectUnknownKeys(protocolVersionObject, ["opensControlPlaneDatabase"], protocolVersionAt)

  const createAt = `${at}.managedCreateInitialize`
  const createObject = requireRecord(object.managedCreateInitialize, createAt)
  rejectUnknownKeys(
    createObject,
    [
      "acquiresSingleWriterCoordinator",
      "completesOnlyAtExactIdleClean",
      "requiresRegisteredRepository",
      "requiresRegisteredStorageVolume",
      "requiresExplicitStorageIdentity",
      "requiresNativeStorageProbeHelper",
      "requiresNativeDedupeHelper",
      "dedupeFenceAdapter",
      "neverFallsBackToUnmanagedGit",
    ],
    createAt,
  )

  const statusAt = `${at}.managedStatus`
  const statusObject = requireRecord(object.managedStatus, statusAt)
  rejectUnknownKeys(
    statusObject,
    ["readOnly", "acquiresSingleWriterCoordinator", "liveGitLockEvidence"],
    statusAt,
  )

  const known = new Set(["protocolVersion", "managedCreateInitialize", "managedStatus"])
  const additions: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(object)) {
    if (known.has(key)) continue
    if (!isRecord(entry)) invalid(`${at}.${key} must be a JSON object for an additive capability extension.`)
    additions[key] = requireBoundedJson({ [key]: entry }, key, at)
  }

  return Object.freeze({
    protocolVersion: Object.freeze({
      opensControlPlaneDatabase: requireBoolean(protocolVersionObject, "opensControlPlaneDatabase", protocolVersionAt),
    }),
    managedCreateInitialize: Object.freeze({
      ...parseCapabilityFlags(
        createObject,
        createAt,
        [
          "acquiresSingleWriterCoordinator",
          "completesOnlyAtExactIdleClean",
          "requiresRegisteredRepository",
          "requiresRegisteredStorageVolume",
          "requiresExplicitStorageIdentity",
          "requiresNativeStorageProbeHelper",
          "requiresNativeDedupeHelper",
          "neverFallsBackToUnmanagedGit",
        ],
      ),
      dedupeFenceAdapter: parseFenceAdapterCapability(
        createObject.dedupeFenceAdapter,
        `${createAt}.dedupeFenceAdapter`,
      ),
    }) as ManagedProtocolCapabilities["managedCreateInitialize"],
    managedStatus: Object.freeze(
      parseCapabilityFlags(statusObject, statusAt, ["readOnly", "acquiresSingleWriterCoordinator", "liveGitLockEvidence"]),
    ) as ManagedProtocolCapabilities["managedStatus"],
    additions: Object.freeze(additions),
  })
}

function parseExitCodes(value: unknown): typeof MANAGED_EXIT_CODES {
  const at = "result.exitCodes"
  const object = requireRecord(value, at)
  rejectUnknownKeys(
    object,
    ["success", "invalidRequest", "contentionRetryable", "reconcileQuarantineFatal", "internalDefect"],
    at,
  )
  const expected = MANAGED_EXIT_CODES
  for (const key of Object.keys(expected) as (keyof typeof MANAGED_EXIT_CODES)[]) {
    const observed = requireInteger(object, key, at, 0, 255)
    if (observed !== expected[key]) invalid(`${at}.${key} must be ${expected[key]}.`)
  }
  return expected
}

export function parseManagedProtocolVersionResult(value: unknown): ManagedProtocolVersionResult {
  return asWire(() => {
    const at = "result"
    const object = requireRecord(value, at)
    rejectUnknownKeys(
      object,
      [
        "managedProtocolVersion",
        "packageName",
        "packageVersion",
        "runtime",
        "commands",
        "exitCodes",
        "capabilities",
        "prerequisites",
      ],
      at,
    )
    if (object.managedProtocolVersion !== MANAGED_PROTOCOL_VERSION) {
      fail(
        MANAGED_ERROR_CODES.protocolVersionUnsupported,
        `${at}.managedProtocolVersion must be ${MANAGED_PROTOCOL_VERSION}.`,
      )
    }
    const commands = requireStringArray(object, "commands", at, {
      minItems: MANAGED_PROTOCOL_COMMANDS.length,
      maxItems: MANAGED_LIMITS.maxCommands,
      maxItemLength: 64,
    })
    for (const command of MANAGED_PROTOCOL_COMMANDS) {
      if (!commands.includes(command)) {
        fail(MANAGED_ERROR_CODES.commandUnsupported, `${at}.commands must include ${command}.`)
      }
    }
    const prerequisites = requireStringArray(object, "prerequisites", at, {
      minItems: 0,
      maxItems: MANAGED_LIMITS.maxCommands,
      maxItemLength: MANAGED_LIMITS.maxEvidenceTextLength,
    })
    return Object.freeze({
      managedProtocolVersion: MANAGED_PROTOCOL_VERSION,
      packageName: requireString(object, "packageName", at, MANAGED_LIMITS.maxNameLength),
      packageVersion: requireString(object, "packageVersion", at, MANAGED_LIMITS.maxNameLength),
      runtime: parseRuntime(object.runtime, `${at}.runtime`),
      commands: Object.freeze([...commands]),
      exitCodes: parseExitCodes(object.exitCodes),
      capabilities: parseCapabilities(object.capabilities),
      prerequisites: Object.freeze([...prerequisites]),
    })
  })
}

function parseOperationEvidence(value: unknown, at: string): ManagedOperationEvidence {
  const object = requireRecord(value, at)
  rejectUnknownKeys(
    object,
    ["operationId", "kind", "state", "expectedRevision", "startedAt", "completedAt", "errorCode", "detailJson"],
    at,
  )
  const detailJson = requireNullableString(object, "detailJson", at, MANAGED_LIMITS.maxEvidenceTextLength)
  return Object.freeze({
    operationId: requireBoundedText(object, "operationId", at),
    kind: requireBoundedText(object, "kind", at),
    state: requireBoundedText(object, "state", at),
    expectedRevision: requireNullableInteger(object, "expectedRevision", at, 0, Number.MAX_SAFE_INTEGER),
    startedAt: requireBoundedText(object, "startedAt", at),
    completedAt: requireNullableString(object, "completedAt", at, MANAGED_LIMITS.maxEvidenceTextLength),
    errorCode: requireNullableString(object, "errorCode", at, MANAGED_LIMITS.maxEvidenceTextLength),
    detailJson,
  })
}

function parseGuardAttemptEvidence(value: unknown, at: string): ManagedGuardAttemptEvidence {
  const object = requireRecord(value, at)
  rejectUnknownKeys(
    object,
    [
      "attemptId",
      "guardId",
      "operationId",
      "donorWorktreeId",
      "targetWorktreeId",
      "donorRevision",
      "targetRevision",
      "state",
      "externalOwnerId",
      "externalAcquisitionId",
      "externalGeneration",
      "createdAt",
      "acquiredAt",
      "releasedAt",
      "updatedAt",
    ],
    at,
  )
  return Object.freeze({
    attemptId: requireBoundedText(object, "attemptId", at),
    guardId: requireBoundedText(object, "guardId", at),
    operationId: requireBoundedText(object, "operationId", at),
    donorWorktreeId: requireBoundedText(object, "donorWorktreeId", at),
    targetWorktreeId: requireBoundedText(object, "targetWorktreeId", at),
    donorRevision: requireInteger(object, "donorRevision", at, 0, Number.MAX_SAFE_INTEGER),
    targetRevision: requireInteger(object, "targetRevision", at, 0, Number.MAX_SAFE_INTEGER),
    state: requireBoundedText(object, "state", at),
    externalOwnerId: requireNullableString(object, "externalOwnerId", at, MANAGED_LIMITS.maxEvidenceTextLength),
    externalAcquisitionId: requireNullableString(object, "externalAcquisitionId", at, MANAGED_LIMITS.maxEvidenceTextLength),
    externalGeneration: requireNullableInteger(object, "externalGeneration", at, 0, Number.MAX_SAFE_INTEGER),
    createdAt: requireBoundedText(object, "createdAt", at),
    acquiredAt: requireNullableString(object, "acquiredAt", at, MANAGED_LIMITS.maxEvidenceTextLength),
    releasedAt: requireNullableString(object, "releasedAt", at, MANAGED_LIMITS.maxEvidenceTextLength),
    updatedAt: requireBoundedText(object, "updatedAt", at),
  })
}

function parseActivityClaimEvidence(value: unknown, at: string): ManagedActivityClaimEvidence {
  const object = requireRecord(value, at)
  rejectUnknownKeys(
    object,
    [
      "sessionId",
      "runtimeOwnerId",
      "agentId",
      "executionGeneration",
      "state",
      "acquiredAt",
      "lastAuthoritativeActivityAt",
      "releasedAt",
      "updatedAt",
    ],
    at,
  )
  return Object.freeze({
    sessionId: requireBoundedText(object, "sessionId", at),
    runtimeOwnerId: requireBoundedText(object, "runtimeOwnerId", at),
    agentId: requireNullableString(object, "agentId", at, MANAGED_LIMITS.maxEvidenceTextLength),
    executionGeneration: requireInteger(object, "executionGeneration", at, 0, Number.MAX_SAFE_INTEGER),
    state: requireBoundedText(object, "state", at),
    acquiredAt: requireBoundedText(object, "acquiredAt", at),
    lastAuthoritativeActivityAt: requireBoundedText(object, "lastAuthoritativeActivityAt", at),
    releasedAt: requireNullableString(object, "releasedAt", at, MANAGED_LIMITS.maxEvidenceTextLength),
    updatedAt: requireBoundedText(object, "updatedAt", at),
  })
}

function parseMaintenanceGuardEvidence(value: unknown, at: string): ManagedMaintenanceGuardEvidence {
  const object = requireRecord(value, at)
  rejectUnknownKeys(
    object,
    ["guardId", "attemptId", "operationId", "generation", "state", "acquiredAt", "releasedAt", "updatedAt"],
    at,
  )
  return Object.freeze({
    guardId: requireBoundedText(object, "guardId", at),
    attemptId: requireBoundedText(object, "attemptId", at),
    operationId: requireNullableString(object, "operationId", at, MANAGED_LIMITS.maxEvidenceTextLength),
    generation: requireInteger(object, "generation", at, 0, Number.MAX_SAFE_INTEGER),
    state: requireBoundedText(object, "state", at),
    acquiredAt: requireBoundedText(object, "acquiredAt", at),
    releasedAt: requireNullableString(object, "releasedAt", at, MANAGED_LIMITS.maxEvidenceTextLength),
    updatedAt: requireBoundedText(object, "updatedAt", at),
  })
}

function parseEvidenceArray<T>(value: unknown, at: string, parse: (entry: unknown, at: string) => T): readonly T[] {
  if (!Array.isArray(value)) invalid(`${at} must be an array.`)
  if (value.length > MANAGED_LIMITS.maxEvidenceItems) {
    invalid(`${at} must contain at most ${MANAGED_LIMITS.maxEvidenceItems} entries.`)
  }
  return Object.freeze(value.map((entry, index) => parse(entry, `${at}[${index}]`)))
}

function parseRepositoryEvidence(value: unknown, at: string): ManagedRepositoryEvidence {
  const object = requireRecord(value, at)
  rejectUnknownKeys(
    object,
    ["id", "canonicalTopLevel", "gitCommonDir", "objectFormat", "identityMethod", "createdAt", "lastSeenAt"],
    at,
  )
  return Object.freeze({
    id: requireBoundedText(object, "id", at),
    canonicalTopLevel: requireBoundedText(object, "canonicalTopLevel", at),
    gitCommonDir: requireBoundedText(object, "gitCommonDir", at),
    objectFormat: requireBoundedText(object, "objectFormat", at),
    identityMethod: requireBoundedText(object, "identityMethod", at),
    createdAt: requireBoundedText(object, "createdAt", at),
    lastSeenAt: requireBoundedText(object, "lastSeenAt", at),
  })
}

function parseStorageVolumeEvidence(value: unknown, at: string): ManagedStorageVolumeEvidence {
  const object = requireRecord(value, at)
  rejectUnknownKeys(
    object,
    ["id", "role", "state", "volumeGuid", "label", "filesystem", "backingPath", "lastVerifiedAt"],
    at,
  )
  return Object.freeze({
    id: requireBoundedText(object, "id", at),
    role: requireBoundedText(object, "role", at),
    state: requireBoundedText(object, "state", at),
    volumeGuid: requireNullableString(object, "volumeGuid", at, MANAGED_LIMITS.maxEvidenceTextLength),
    label: requireNullableString(object, "label", at, MANAGED_LIMITS.maxEvidenceTextLength),
    filesystem: requireNullableString(object, "filesystem", at, MANAGED_LIMITS.maxEvidenceTextLength),
    backingPath: requireNullableString(object, "backingPath", at, MANAGED_LIMITS.maxEvidenceTextLength),
    lastVerifiedAt: requireNullableString(object, "lastVerifiedAt", at, MANAGED_LIMITS.maxEvidenceTextLength),
  })
}

function parseWorktreeRow(value: unknown, at: string): ManagedWorktreeRow {
  const object = requireRecord(value, at)
  rejectUnknownKeys(
    object,
    [
      "repositoryId",
      "storageVolumeId",
      "path",
      "pathKey",
      "ownership",
      "head",
      "branchRef",
      "pinRef",
      "durabilityClass",
      "lifecycleState",
      "revision",
      "createdAt",
      "updatedAt",
    ],
    at,
  )
  return Object.freeze({
    repositoryId: requireBoundedText(object, "repositoryId", at),
    storageVolumeId: requireNullableString(object, "storageVolumeId", at, MANAGED_LIMITS.maxEvidenceTextLength),
    path: requireBoundedText(object, "path", at),
    pathKey: requireBoundedText(object, "pathKey", at),
    ownership: requireBoundedText(object, "ownership", at),
    head: requireBoundedText(object, "head", at),
    branchRef: requireNullableString(object, "branchRef", at, MANAGED_LIMITS.maxEvidenceTextLength),
    pinRef: requireNullableString(object, "pinRef", at, MANAGED_LIMITS.maxEvidenceTextLength),
    durabilityClass: requireBoundedText(object, "durabilityClass", at),
    lifecycleState: requireBoundedText(object, "lifecycleState", at),
    revision: requireInteger(object, "revision", at, 0, Number.MAX_SAFE_INTEGER),
    createdAt: requireBoundedText(object, "createdAt", at),
    updatedAt: requireBoundedText(object, "updatedAt", at),
  })
}

function parseGitEvidence(value: unknown, at: string): ManagedGitEvidence {
  const object = requireRecord(value, at)
  rejectUnknownKeys(
    object,
    [
      "probe",
      "repositoryPath",
      "worktreePath",
      "registered",
      "locked",
      "lockReason",
      "head",
      "branchRef",
      "bare",
      "detached",
      "prunable",
      "unknownAttributes",
      "error",
    ],
    at,
  )
  const probe = object.probe
  if (probe !== "ok" && probe !== "unavailable" && probe !== "error") {
    invalid(`${at}.probe must be one of: ok, unavailable, error.`)
  }
  const nullableBoolean = (key: string): boolean | null => {
    if (object[key] === null) return null
    return requireBoolean(object, key, at)
  }
  return Object.freeze({
    probe,
    repositoryPath: requireBoundedText(object, "repositoryPath", at),
    worktreePath: requireBoundedText(object, "worktreePath", at),
    registered: nullableBoolean("registered"),
    locked: nullableBoolean("locked"),
    lockReason: requireNullableString(object, "lockReason", at, MANAGED_LIMITS.maxEvidenceTextLength),
    head: requireNullableString(object, "head", at, MANAGED_LIMITS.maxEvidenceTextLength),
    branchRef: requireNullableString(object, "branchRef", at, MANAGED_LIMITS.maxEvidenceTextLength),
    bare: nullableBoolean("bare"),
    detached: nullableBoolean("detached"),
    prunable: nullableBoolean("prunable"),
    unknownAttributes: requireStringArray(object, "unknownAttributes", at, {
      minItems: 0,
      maxItems: MANAGED_LIMITS.maxEvidenceItems,
      maxItemLength: MANAGED_LIMITS.maxEvidenceTextLength,
    }),
    error: requireNullableString(object, "error", at, MANAGED_LIMITS.maxEvidenceTextLength),
  })
}

export function parseManagedStatusResult(value: unknown, expected: { readonly worktreeId: string }): ManagedStatusResult {
  return asWire(() => {
    const at = "result"
    const object = requireRecord(value, at)
    rejectUnknownKeys(
      object,
      [
        "worktreeId",
        "repository",
        "storageVolume",
        "worktree",
        "revision",
        "quarantine",
        "handoff",
        "operations",
        "guardAttempts",
        "activityClaims",
        "maintenanceGuards",
        "gitEvidence",
      ],
      at,
    )
    const worktreeId = requireBoundedText(object, "worktreeId", at)
    if (worktreeId !== expected.worktreeId) {
      fail(MANAGED_ERROR_CODES.worktreeIdentityConflict, `${at}.worktreeId must echo ${expected.worktreeId}.`)
    }
    const revisionAt = `${at}.revision`
    const revisionObject = requireRecord(object.revision, revisionAt)
    rejectUnknownKeys(revisionObject, ["actual", "openOperationExpectedRevisions"], revisionAt)
    const openOperationExpectedRevisions = parseEvidenceArray(
      revisionObject.openOperationExpectedRevisions,
      `${revisionAt}.openOperationExpectedRevisions`,
      (entry, entryAt) => {
        const record = requireRecord(entry, entryAt)
        rejectUnknownKeys(record, ["operationId", "expectedRevision"], entryAt)
        return Object.freeze({
          operationId: requireBoundedText(record, "operationId", entryAt),
          expectedRevision: requireNullableInteger(record, "expectedRevision", entryAt, 0, Number.MAX_SAFE_INTEGER),
        })
      },
    )
    const quarantineAt = `${at}.quarantine`
    const quarantine =
      object.quarantine === null
        ? null
        : (() => {
            const record = requireRecord(object.quarantine, quarantineAt)
            rejectUnknownKeys(record, ["quarantined", "lifecycleState", "durabilityClass"], quarantineAt)
            return Object.freeze({
              quarantined: requireBoolean(record, "quarantined", quarantineAt),
              lifecycleState: requireBoundedText(record, "lifecycleState", quarantineAt),
              durabilityClass: requireBoundedText(record, "durabilityClass", quarantineAt),
            })
          })()
    const handoffAt = `${at}.handoff`
    const handoffObject = requireRecord(object.handoff, handoffAt)
    rejectUnknownKeys(
      handoffObject,
      [
        "reconcileRequired",
        "reasons",
        "openOperationCount",
        "unresolvedGuardAttemptCount",
        "reconcileRequiredGuardAttemptCount",
        "reconcileRequiredActivityClaimCount",
        "reconcileRequiredMaintenanceGuardCount",
      ],
      handoffAt,
    )
    const operationsAt = `${at}.operations`
    const operationsObject = requireRecord(object.operations, operationsAt)
    rejectUnknownKeys(operationsObject, ["open", "latest"], operationsAt)

    const worktreeAt = `${at}.worktree`
    const worktree =
      object.worktree === null ? null : parseWorktreeRow(object.worktree, worktreeAt)
    if (worktree === null) {
      fail(MANAGED_ERROR_CODES.worktreeNotFound, "successful managed-status must observe a registered worktree.")
    }
    if (revisionObject.actual !== worktree.revision) {
      fail(MANAGED_ERROR_CODES.fatalFailure, `${revisionAt}.actual must equal ${worktreeAt}.revision.`)
    }

    return Object.freeze({
      worktreeId,
      repository: parseRepositoryEvidence(object.repository, `${at}.repository`),
      storageVolume:
        object.storageVolume === null ? null : parseStorageVolumeEvidence(object.storageVolume, `${at}.storageVolume`),
      worktree,
      revision: Object.freeze({
        actual: requireInteger(revisionObject, "actual", revisionAt, 0, Number.MAX_SAFE_INTEGER),
        openOperationExpectedRevisions,
      }),
      quarantine,
      handoff: Object.freeze({
        reconcileRequired: requireBoolean(handoffObject, "reconcileRequired", handoffAt),
        reasons: requireStringArray(handoffObject, "reasons", handoffAt, {
          minItems: 0,
          maxItems: MANAGED_LIMITS.maxEvidenceItems,
          maxItemLength: MANAGED_LIMITS.maxEvidenceTextLength,
        }),
        openOperationCount: requireInteger(handoffObject, "openOperationCount", handoffAt, 0, Number.MAX_SAFE_INTEGER),
        unresolvedGuardAttemptCount: requireInteger(
          handoffObject,
          "unresolvedGuardAttemptCount",
          handoffAt,
          0,
          Number.MAX_SAFE_INTEGER,
        ),
        reconcileRequiredGuardAttemptCount: requireInteger(
          handoffObject,
          "reconcileRequiredGuardAttemptCount",
          handoffAt,
          0,
          Number.MAX_SAFE_INTEGER,
        ),
        reconcileRequiredActivityClaimCount: requireInteger(
          handoffObject,
          "reconcileRequiredActivityClaimCount",
          handoffAt,
          0,
          Number.MAX_SAFE_INTEGER,
        ),
        reconcileRequiredMaintenanceGuardCount: requireInteger(
          handoffObject,
          "reconcileRequiredMaintenanceGuardCount",
          handoffAt,
          0,
          Number.MAX_SAFE_INTEGER,
        ),
      }),
      operations: Object.freeze({
        open: parseEvidenceArray(operationsObject.open, `${operationsAt}.open`, parseOperationEvidence),
        latest: parseEvidenceArray(operationsObject.latest, `${operationsAt}.latest`, parseOperationEvidence),
      }),
      guardAttempts: parseEvidenceArray(object.guardAttempts, `${at}.guardAttempts`, parseGuardAttemptEvidence),
      activityClaims: parseEvidenceArray(object.activityClaims, `${at}.activityClaims`, parseActivityClaimEvidence),
      maintenanceGuards: parseEvidenceArray(
        object.maintenanceGuards,
        `${at}.maintenanceGuards`,
        parseMaintenanceGuardEvidence,
      ),
      gitEvidence: parseGitEvidence(object.gitEvidence, `${at}.gitEvidence`),
    })
  })
}

function pathIdentity(value: string): string {
  return value.replace(/[\\/]+$/, "").toLocaleLowerCase("en-US")
}

export function parseManagedCreateInitializeResult(
  value: unknown,
  expected: { readonly request: ManagedCreateInitializeRequest },
): ManagedCreateInitializeResult {
  return asWire(() => {
    const at = "result"
    const object = requireRecord(value, at)
    rejectUnknownKeys(
      object,
      [
        "worktreeId",
        "repositoryId",
        "storageVolumeId",
        "targetPath",
        "pathKey",
        "ownership",
        "lifecycleState",
        "durabilityClass",
        "revision",
        "head",
        "branchRef",
        "pinRef",
        "createOperationId",
        "initializationOperationId",
        "summary",
        "idempotent",
      ],
      at,
    )
    const worktreeId = requireBoundedText(object, "worktreeId", at)
    const repositoryId = requireBoundedText(object, "repositoryId", at)
    const storageVolumeId = requireBoundedText(object, "storageVolumeId", at)
    const targetPath = requireBoundedText(object, "targetPath", at)
    const ownership = requireBoundedText(object, "ownership", at)
    const lifecycleState = requireBoundedText(object, "lifecycleState", at)
    const durabilityClass = requireBoundedText(object, "durabilityClass", at)
    const expectedBranchRef = `refs/heads/${expected.request.branchName}`
    const expectedPinRef = `refs/worktree-store/pins/${expected.request.worktreeId}`

    if (worktreeId !== expected.request.worktreeId) {
      fail(MANAGED_ERROR_CODES.worktreeIdentityConflict, `${at}.worktreeId must echo ${expected.request.worktreeId}.`)
    }
    if (repositoryId !== expected.request.repositoryId) {
      fail(MANAGED_ERROR_CODES.worktreeIdentityConflict, `${at}.repositoryId must echo ${expected.request.repositoryId}.`)
    }
    if (storageVolumeId !== expected.request.storageVolumeId) {
      fail(
        MANAGED_ERROR_CODES.worktreeIdentityConflict,
        `${at}.storageVolumeId must echo ${expected.request.storageVolumeId}.`,
      )
    }
    if (pathIdentity(targetPath) !== pathIdentity(expected.request.targetPath)) {
      fail(MANAGED_ERROR_CODES.worktreeIdentityConflict, `${at}.targetPath must echo the requested target path.`)
    }
    if (ownership !== "managed") fail(MANAGED_ERROR_CODES.fatalFailure, `${at}.ownership must be managed.`)
    if (lifecycleState !== "idle_clean") {
      fail(MANAGED_ERROR_CODES.fatalFailure, `${at}.lifecycleState must be idle_clean.`)
    }
    if (durabilityClass !== "reconstructable_clean") {
      fail(MANAGED_ERROR_CODES.fatalFailure, `${at}.durabilityClass must be reconstructable_clean.`)
    }
    const branchRef = requireNullableString(object, "branchRef", at, MANAGED_LIMITS.maxEvidenceTextLength)
    if (branchRef !== expectedBranchRef) {
      fail(MANAGED_ERROR_CODES.worktreeIdentityConflict, `${at}.branchRef must be ${expectedBranchRef}.`)
    }
    const pinRef = requireNullableString(object, "pinRef", at, MANAGED_LIMITS.maxEvidenceTextLength)
    if (pinRef !== expectedPinRef) {
      fail(MANAGED_ERROR_CODES.worktreeIdentityConflict, `${at}.pinRef must be ${expectedPinRef}.`)
    }
    const idempotent = requireBoolean(object, "idempotent", at)
    const createOperationId = requireNullableString(object, "createOperationId", at, MANAGED_LIMITS.maxEvidenceTextLength)
    const initializationOperationId = requireNullableString(
      object,
      "initializationOperationId",
      at,
      MANAGED_LIMITS.maxEvidenceTextLength,
    )
    if (!idempotent && (createOperationId === null || initializationOperationId === null)) {
      fail(
        MANAGED_ERROR_CODES.fatalFailure,
        `${at}.createOperationId and ${at}.initializationOperationId are required for a non-idempotent create.`,
      )
    }

    return Object.freeze({
      worktreeId,
      repositoryId,
      storageVolumeId,
      targetPath,
      pathKey: requireBoundedText(object, "pathKey", at),
      ownership,
      lifecycleState,
      durabilityClass,
      revision: requireInteger(object, "revision", at, 1, Number.MAX_SAFE_INTEGER),
      head: requireBoundedText(object, "head", at),
      branchRef,
      pinRef,
      createOperationId,
      initializationOperationId,
      summary: requireBoundedJson(object, "summary", at) ?? null,
      idempotent,
    })
  })
}

export * as ManagedProtocol from "./protocol"
