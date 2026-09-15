// SnapEye-compatible host contract used by OpenCode's first-party visual lane.
//
// Keep these values aligned with @zumer/snapeye protocol/schema v1. The page
// runtime can therefore interoperate with `npx snapeye` baselines while the
// Desktop host remains the only component allowed to choose filesystem paths.

export const SNAPEYE_SCHEMA_VERSION = 1 as const
export const SNAPEYE_PROTOCOL_VERSION = 1 as const
export const SNAPEYE_ROOT = ".snapeye"
export const SNAPEYE_BASELINES_DIR = "baselines"
export const SNAPEYE_RUNS_DIR = "runs"
export const SNAPEYE_MAX_ID_LENGTH = 64
export const SNAPEYE_DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

export const SNAPEYE_ARTIFACTS = {
  result: "result.json",
  current: "current.png",
  svg: "current.svg",
  diff: "diff.png",
  frames: "frames.png",
  gif: "recording.gif",
  webm: "recording.webm",
  mp4: "recording.mp4",
} as const

export const SNAPEYE_RUN_ARTIFACTS = new Set<string>([
  SNAPEYE_ARTIFACTS.current,
  SNAPEYE_ARTIFACTS.svg,
  SNAPEYE_ARTIFACTS.diff,
  SNAPEYE_ARTIFACTS.frames,
  SNAPEYE_ARTIFACTS.gif,
  SNAPEYE_ARTIFACTS.webm,
  SNAPEYE_ARTIFACTS.mp4,
])

export const SNAPEYE_ERROR_CODES = new Set([
  "INVALID_RUN_ID",
  "INVALID_NAME",
  "INVALID_OPERATION",
  "TARGET_NOT_FOUND",
  "BASELINE_NOT_FOUND",
  "BASELINE_INCOMPATIBLE",
  "CAPTURE_FAILED",
  "DIFF_FAILED",
  "RECORD_FAILED",
  "PERSIST_FAILED",
])

export type SnapEyeOperation = "capture" | "diff" | "record"
export type SnapEyeResultOperation = SnapEyeOperation | "unknown"

export interface SnapEyeStoredBaseline {
  name?: string
  image: Uint8Array | ArrayBuffer
  meta: Record<string, unknown> | null
}

export interface SnapEyeResult {
  schemaVersion: 1
  protocolVersion: 1
  runId: string
  status: "ok" | "error"
  operation: SnapEyeResultOperation
  name?: string
  [key: string]: unknown
}

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const hasTraversal = (value: string): boolean =>
  value === "." ||
  value === ".." ||
  value.includes("..") ||
  value.includes("/") ||
  value.includes("\\") ||
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f
  })

export const isValidSnapEyeRunId = (value: unknown): value is string =>
  typeof value === "string" && RUN_ID_RE.test(value) && !hasTraversal(value)

export const isValidSnapEyeName = (value: unknown): value is string =>
  typeof value === "string" && NAME_RE.test(value) && !hasTraversal(value)

export const isValidSnapEyeFilename = (value: unknown): value is string =>
  typeof value === "string" &&
  FILENAME_RE.test(value) &&
  !hasTraversal(value) &&
  !value.endsWith(".") &&
  !value.endsWith(".tmp")

export const generateSnapEyeRunId = (now = Date.now(), random = Math.random): string => {
  const stamp = Number(now).toString(36).padStart(9, "0").slice(-9)
  let suffix = ""
  for (let index = 0; index < 6; index++) suffix += Math.floor(random() * 36).toString(36)
  return `r${stamp}${suffix}`
}

export const validateSnapEyeResult = (value: unknown, expectedRunId: string): string | null => {
  if (!isPlainObject(value)) return "result must be an object"
  if (value.schemaVersion !== SNAPEYE_SCHEMA_VERSION) return `unsupported schemaVersion: ${String(value.schemaVersion)}`
  if (value.protocolVersion !== SNAPEYE_PROTOCOL_VERSION) return `unsupported protocolVersion: ${String(value.protocolVersion)}`
  if (!isValidSnapEyeRunId(value.runId)) return "result.runId is not a valid run id"
  if (value.runId !== expectedRunId) return "result.runId does not match the run being committed"
  if (value.status !== "ok" && value.status !== "error") return 'result.status must be "ok" or "error"'
  if (value.operation !== "capture" && value.operation !== "diff" && value.operation !== "record" && value.operation !== "unknown") {
    return `unknown operation: ${String(value.operation)}`
  }
  if (value.status === "error") {
    if (!isPlainObject(value.error)) return "error result must carry an error object"
    if (!SNAPEYE_ERROR_CODES.has(String(value.error.code))) return `unknown error code: ${String(value.error.code)}`
  }
  return null
}

export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export class VisualArtifactError extends Error {
  constructor(
    public readonly code:
      | "INVALID_PATH"
      | "INVALID_NAME"
      | "INVALID_RUN_ID"
      | "INVALID_ARTIFACT"
      | "INVALID_BASELINE_METADATA"
      | "BASELINE_INTEGRITY"
      | "RUN_ALREADY_TERMINAL"
      | "RESULT_ALREADY_COMMITTED"
      | "INVALID_RESULT"
      | "REVIEW_CHANGED"
      | "ARTIFACT_TOO_LARGE"
      | "TRANSFER_SIZE_MISMATCH"
      | "TRANSFER_CLOSED",
    message: string,
  ) {
    super(message)
    this.name = "VisualArtifactError"
  }
}
