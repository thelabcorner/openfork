export interface Attachment {
  readonly kind: "file" | "resource"
  readonly handle: string
  readonly mediaType?: string
  readonly name?: string
  readonly bytes?: number
}

export interface MutationResult {
  readonly attempted: boolean
  readonly committed: boolean
}

export interface CapabilityResult {
  readonly title?: string
  readonly output: string
  readonly structured?: unknown
  readonly attachments?: readonly Attachment[]
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly mutation?: MutationResult
}

export interface ErrorProjection {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
}

const retryable = new Set([
  "OXP_BUSY",
  "OXP_TIMEOUT",
  "OXP_DEPENDENCY_UNAVAILABLE",
  "OXP_INTEGRATION_OFFLINE",
  "OXP_AMBIGUOUS_EXTERNAL_RESULT",
])

export function projectError(error: import("./error").OxpError.Error): ErrorProjection {
  return Object.freeze({
    code: error._tag,
    message: error.message,
    retryable: retryable.has(error._tag),
    ...(error.metadata ? { metadata: error.metadata } : {}),
  })
}

export * as OxpResult from "./result"
