import { randomUUID } from "node:crypto"

const CAPACITY = 64
const MAX_STACK_FRAMES = 12

export type Phase =
  | "activity_recording"
  | "tool_boundary"
  | "result_validation"
  | "result_projection"
  | "mcp_transport"
  | "request_body"

/** Fixed diagnostic enum: never persist SQL, parameters, paths, or user input. */
export type ActivityOperation = "begin" | "link" | "settle" | "registerSession"

function safeActivityOperation(value: unknown): ActivityOperation | undefined {
  return value === "begin" || value === "link" || value === "settle" || value === "registerSession"
    ? value
    : undefined
}

export interface Incident {
  readonly id: string
  readonly at: number
  readonly phase: Phase
  readonly activityOperation?: ActivityOperation
  readonly surfaceFingerprint?: string
  readonly tool?: string
  readonly action?: string
  readonly errorName: string
  readonly errorCode?: string
  readonly message: string
  readonly frames: readonly string[]
}

interface Store {
  readonly rows: Incident[]
}

const key = Symbol.for("openfork.oxp.diagnostics.v1")
const root = globalThis as typeof globalThis & { [key]?: Store }
const store = (root[key] ??= { rows: [] })

function safeLabel(value: unknown, max: number) {
  if (typeof value !== "string") return undefined
  const clean = value.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, max)
  return clean || undefined
}

function safeErrorCode(value: unknown) {
  if (typeof value !== "string") return undefined
  return /^(?:OXP_[A-Z0-9_]+|SQLITE_[A-Z0-9_]+|ERR_[A-Z0-9_]+)$/.test(value) ? value : undefined
}

function safeAction(tool: unknown, action: unknown) {
  if (tool !== "openfork_info") return undefined
  return action === "status" || action === "capabilities" || action === "diagnostics" ? action : undefined
}

/**
 * Classify a real SQL driver failure without persisting SQL statements, bound
 * values, disk paths or user input. Effect SQL wraps native errors under
 * reason/cause; only inspect those explicit error slots, never arbitrary keys.
 * Do not infer a SQLite failure from free-form exception text.
 */
export function sqliteIncidentCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const top = error as { name?: unknown; _tag?: unknown; constructor?: { name?: unknown } }
  const name = top._tag ?? top.constructor?.name ?? top.name
  if (name !== "SqlError" && name !== "SQLITE_ERROR") return undefined
  const stack: unknown[] = [error]
  const seen = new Set<object>()
  while (stack.length > 0 && seen.size < 24) {
    const current = stack.pop()
    if (!current || typeof current !== "object" || seen.has(current)) continue
    seen.add(current)
    const node = current as Record<string, unknown>
    const code = safeErrorCode(node.code)
    if (code?.startsWith("SQLITE_")) return code
    const errno = node.errno ?? node.errcode
    if (typeof errno === "number" && Number.isSafeInteger(errno) && errno >= 0) {
      const base = errno & 255
      if (errno === 517) return "SQLITE_BUSY_SNAPSHOT"
      if (base === 5) return "SQLITE_BUSY"
      if (base === 19) return "SQLITE_CONSTRAINT"
      if (base === 1) return "SQLITE_ERROR"
      if (base === 6) return "SQLITE_LOCKED"
      if (base === 8) return "SQLITE_READONLY"
      if (base === 10) return "SQLITE_IOERR"
      if (base === 13) return "SQLITE_FULL"
      if (base === 17) return "SQLITE_SCHEMA"
    }
    // Our SQLite adapter emits this deliberately parameter-free diagnostic.
    // Match the *whole* message, not arbitrary text supplied by a caller.
    if (typeof node.message === "string") {
      const match = /^Failed to execute statement class=[A-Z]+ sqlite=(SQLITE_[A-Z0-9_]+)$/.exec(node.message)
      if (match) return safeErrorCode(match[1])
    }
    for (const field of ["reason", "cause", "error", "defect", "failure"] as const) {
      try { if (node[field] && typeof node[field] === "object") stack.push(node[field]) } catch {}
    }
  }
  return "SQLITE_UNCLASSIFIED"
}

function errorFields(cause: unknown) {
  try {
    if (cause instanceof Error) {
      const candidate = cause as Error & { _tag?: unknown; code?: unknown }
      return {
        errorName: safeLabel(candidate._tag ?? cause.constructor?.name ?? candidate.name, 64) ?? "Error",
        errorCode: safeErrorCode(candidate._tag ?? candidate.code) ?? sqliteIncidentCode(cause),
        message: "Unexpected OXP failure; inspect the error code and source frames.",
        stack: candidate.stack,
      }
    }
    const candidate = cause && typeof cause === "object" ? (cause as Record<string, unknown>) : undefined
    return {
      errorName: safeLabel(candidate?._tag ?? candidate?.name, 64) ?? "UnknownError",
      errorCode: safeErrorCode(candidate?._tag ?? candidate?.code) ?? sqliteIncidentCode(cause),
      message: "Unexpected non-Error exception",
      stack: undefined,
    }
  } catch {
    return {
      errorName: "UnknownError",
      message: "Exception details were unavailable.",
      stack: undefined,
    }
  }
}

function safeFrames(stack: string | undefined) {
  if (!stack) return []
  return stack
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const source = line.match(/([\w.-]+\.(?:tsx?|jsx?|mjs|cjs))(:(\d+))?(:(\d+))?/i)
      if (!source) return []
      const file = source[1]!
      const location = source[2] ?? ""
      return [`${file}${location}`]
    })
    .slice(0, MAX_STACK_FRAMES)
}

export function record(input: {
  readonly cause: unknown
  readonly phase: Phase
  readonly activityOperation?: ActivityOperation
  readonly tool?: string
  readonly action?: string
  readonly surfaceFingerprint?: string
}): Incident {
  const error = errorFields(input.cause)
  const incident: Incident = Object.freeze({
    id: randomUUID(),
    at: Date.now(),
    phase: input.phase,
    ...(input.phase === "activity_recording" && safeActivityOperation(input.activityOperation)
      ? { activityOperation: safeActivityOperation(input.activityOperation) }
      : {}),
    ...(input.surfaceFingerprint ? { surfaceFingerprint: safeLabel(input.surfaceFingerprint, 64) } : {}),
    ...(safeLabel(input.tool, 64) ? { tool: safeLabel(input.tool, 64) } : {}),
    ...(safeAction(input.tool, input.action) ? { action: safeAction(input.tool, input.action) } : {}),
    errorName: error.errorName,
    ...(error.errorCode ? { errorCode: error.errorCode } : {}),
    message: error.message,
    frames: Object.freeze(safeFrames(error.stack)),
  })
  store.rows.push(incident)
  if (store.rows.length > CAPACITY) store.rows.splice(0, store.rows.length - CAPACITY)
  return incident
}

export function list(input: { readonly limit?: number; readonly id?: string } = {}) {
  const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? 10)))
  if (input.id) return store.rows.filter((incident) => incident.id === input.id).slice(0, 1)
  return store.rows.slice(-limit).reverse()
}

export function size() {
  return store.rows.length
}

export * as OxpDiagnostics from "./diagnostics"
