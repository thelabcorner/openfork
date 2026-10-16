export * as RevisionProgress from "./revision-progress"

import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "./effect/app-node"

/**
 * Latest-value progress projection for one in-flight revision operation.
 *
 * Progress is advisory, self-reported telemetry: it is never completion, never
 * durable domain state, and never a reason to fail or extend a revision. The
 * host therefore keeps only the newest values for a bounded set of concurrent
 * operations, in process memory:
 *
 * - `percent` is clamped to an integer 0..100 and never moves backwards
 *   (monotonic max), so a model correction or an out-of-order update cannot
 *   make the composer regress.
 * - `phase`/`note` carry the latest accepted update's bounded text.
 * - entries expire by TTL and the tracked set is capped by LRU eviction, so a
 *   caller that never settles cannot grow memory.
 * - `clear` runs when the owning revision settles; the TTL is only a backstop
 *   for interrupts/defects that bypass settlement.
 *
 * There is deliberately no per-update row, history array, or second content
 * stream anywhere: any number of progress updates collapses into this one
 * latest-value slot keyed by the client-owned operation id.
 */
export const MAX_TRACKED_OPERATIONS = 64
export const OPERATION_TTL_MS = 10 * 60_000
export const MAX_OPERATION_ID_CHARS = 128
export const MAX_PHASE_CHARS = 60
export const MAX_NOTE_CHARS = 160

export const Snapshot = Schema.Struct({
  operationID: Schema.String,
  percent: Schema.Number,
  phase: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  updatedAt: Schema.Number,
})
export type Snapshot = typeof Snapshot.Type

export interface ReportInput {
  readonly operationID: string
  readonly percent: number
  readonly phase?: unknown
  readonly note?: unknown
  /** Injectable clock for tests; production uses `Date.now()`. */
  readonly now?: number
}

export interface Interface {
  /**
   * Record the latest advisory progress for one operation. Non-finite or
   * missing values are ignored (never an error), and a lower percentage only
   * updates phase/note/timestamp.
   */
  readonly report: (input: ReportInput) => Effect.Effect<Snapshot | undefined>
  /** Latest value while the operation is tracked, or `undefined` when settled/unknown/stale. */
  readonly latest: (operationID: string, now?: number) => Effect.Effect<Snapshot | undefined>
  /** Drop one operation's projection at settle. */
  readonly clear: (operationID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/RevisionProgress") {}

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

/**
 * Correlation ids cross the HTTP boundary, so they are bounded and
 * charset-checked before they are ever used as a map key. An unusable id
 * disables tracking rather than failing the revision.
 */
export function normalizeOperationID(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const id = value.trim()
  if (!id || id.length > MAX_OPERATION_ID_CHARS || !OPERATION_ID_PATTERN.test(id)) return undefined
  return id
}

/** Invalid or non-finite percentages are ignored, never allowed to fail a revision. */
export function clampPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(100, Math.round(value)))
}

const boundedText = (value: unknown, max: number) => {
  if (typeof value !== "string") return undefined
  const text = value.trim().slice(0, max)
  return text.length > 0 ? text : undefined
}

export const make = Effect.gen(function* () {
  const entries = new Map<string, Snapshot>()

  const evictExpired = (now: number) => {
    for (const [key, entry] of entries) {
      if (now - entry.updatedAt >= OPERATION_TTL_MS) entries.delete(key)
    }
  }

  const evictOverflow = () => {
    while (entries.size > MAX_TRACKED_OPERATIONS) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, entry] of entries) {
        if (entry.updatedAt < oldestAt) {
          oldestAt = entry.updatedAt
          oldestKey = key
        }
      }
      if (oldestKey === undefined) return
      entries.delete(oldestKey)
    }
  }

  const report = Effect.fn("RevisionProgress.report")(function* (input: ReportInput) {
    const operationID = normalizeOperationID(input.operationID)
    const percent = clampPercent(input.percent)
    if (operationID === undefined || percent === undefined) return undefined
    const now = input.now ?? Date.now()
    evictExpired(now)
    const previous = entries.get(operationID)
    const phase = boundedText(input.phase, MAX_PHASE_CHARS)
    const note = boundedText(input.note, MAX_NOTE_CHARS)
    const next: Snapshot = {
      operationID,
      percent: Math.max(previous?.percent ?? 0, percent),
      ...(phase === undefined ? {} : { phase }),
      ...(note === undefined ? {} : { note }),
      updatedAt: now,
    }
    // Map re-insertion keeps the eviction scan ordering intuitive (oldest
    // `updatedAt` first) without a second LRU bookkeeping structure.
    entries.delete(operationID)
    entries.set(operationID, next)
    evictOverflow()
    return next
  })

  const latest = Effect.fn("RevisionProgress.latest")(function* (operationID: string, now?: number) {
    const id = normalizeOperationID(operationID)
    if (id === undefined) return undefined
    evictExpired(now ?? Date.now())
    const entry = entries.get(id)
    return entry === undefined ? undefined : { ...entry }
  })

  const clear = Effect.fn("RevisionProgress.clear")(function* (operationID: string) {
    const id = normalizeOperationID(operationID)
    if (id !== undefined) entries.delete(id)
  })

  return Service.of({ report, latest, clear })
})

export const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
