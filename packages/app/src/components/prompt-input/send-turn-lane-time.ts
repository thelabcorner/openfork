import { sessionTelemetryLocalStartedAt } from "@/utils/session-telemetry-time"

export type PromptTurnClockAnchorInput = {
  readonly turnStartedAt?: number
  readonly sampledAt?: number
  readonly updatedAt?: number
  readonly receivedAt?: number
  readonly observedAt: number
  readonly previousTurnStartedAt?: number
  readonly previousLocalStartedAt?: number
}

/**
 * Translate the producer's turn interval into the renderer's monotonic clock
 * domain. sampledAt-turnStartedAt stays entirely producer-owned; receipt/current
 * timestamps stay entirely renderer-owned. updatedAt is only the rolling-
 * upgrade fallback for servers that predate sampledAt.
 *
 * Keeping the earliest mapping for the same turn also prevents a later delayed
 * telemetry frame from making the displayed clock jump backward.
 */
export function promptTurnLocalStartedAt(input: PromptTurnClockAnchorInput) {
  const startedAt = input.turnStartedAt
  if (startedAt === undefined || !Number.isFinite(startedAt) || !Number.isFinite(input.observedAt)) return undefined

  const mapped = sessionTelemetryLocalStartedAt({
    startedAt,
    sampledAt: input.sampledAt,
    updatedAt: input.updatedAt,
    receivedAt: input.receivedAt,
    now: input.observedAt,
  })
  if (mapped === undefined) return undefined
  if (
    input.previousTurnStartedAt === startedAt &&
    input.previousLocalStartedAt !== undefined &&
    Number.isFinite(input.previousLocalStartedAt)
  )
    return Math.min(input.previousLocalStartedAt, mapped)
  return mapped
}

export type PromptTurnElapsedInput = {
  readonly working: boolean
  readonly liveStartedAt?: number
  readonly presentationStartedAt?: number
  readonly completedAt?: number
  readonly now: number
}

/**
 * Resolve elapsed wall time for the turn lane without allowing a completed
 * turn's presentation latch to masquerade as the next live turn.
 *
 * While execution is live, only producer-owned live telemetry may anchor the
 * clock. The presentation timestamp exists solely to freeze/animate the just-
 * completed turn after `working` becomes false.
 */
export function promptTurnElapsedMs(input: PromptTurnElapsedInput) {
  const startedAt = input.working ? input.liveStartedAt : input.presentationStartedAt
  if (startedAt === undefined || !Number.isFinite(startedAt)) return 0

  const rawEnd = input.working ? input.now : (input.completedAt ?? input.now)
  const end = Number.isFinite(rawEnd) ? rawEnd : input.now
  return Math.max(0, end - startedAt)
}

/**
 * Compact, width-bounded elapsed labels for the fixed-width turn lane.
 *
 * Seconds retain tenths while they are useful. Once the turn reaches one hour,
 * seconds are deliberately dropped rather than allowing labels such as
 * "97m 05s" (or a three-digit minute count) to overflow the 48px clock cell.
 */
export function promptTurnElapsedLabel(ms: number) {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0
  if (safe < 1000) return `${Math.round(safe / 100) / 10}s`
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`

  const totalMinutes = Math.floor(safe / 60_000)
  const seconds = Math.floor((safe % 60_000) / 1000)
  if (totalMinutes < 60) return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`

  const totalHours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (totalHours < 24) return `${totalHours}h ${String(minutes).padStart(2, "0")}m`

  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  if (days < 100) return `${days}d ${String(hours).padStart(2, "0")}h`
  return "99d+"
}