export type SessionTelemetryClockInput = {
  /** Producer-domain timestamp that begins the interval. */
  readonly startedAt?: number
  /**
   * Producer-domain timestamp captured when the telemetry payload was
   * materialized. New servers provide this; updatedAt is a rolling-upgrade
   * fallback and is not otherwise treated as a sampling clock.
   */
  readonly sampledAt?: number
  readonly updatedAt?: number
  /** Client-local monotonic timestamp captured when the payload was accepted. */
  readonly receivedAt?: number
  /** Current client-local monotonic timestamp. */
  readonly now: number
}

/**
 * Monotonic clock for client-side elapsed-time continuation.
 *
 * Producer timestamps are epoch milliseconds, but producer and client wall
 * clocks are not assumed to agree. performance.now() is intentionally used
 * only for local deltas after a telemetry frame is received.
 */
export function sessionTelemetryClientNow() {
  return typeof performance === "object" && typeof performance.now === "function" ? performance.now() : Date.now()
}

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value)
}

/**
 * Elapsed time across two independent clock domains.
 *
 * The first leg is computed entirely in the producer domain
 * (sampledAt-startedAt). The second leg is computed entirely in the client
 * monotonic domain (now-receivedAt). Absolute producer timestamps are never
 * subtracted from the client clock.
 */
export function sessionTelemetryElapsedMs(input: SessionTelemetryClockInput) {
  if (!finite(input.startedAt)) return 0

  const sampledAt = finite(input.sampledAt) ? input.sampledAt : input.updatedAt
  if (!finite(sampledAt)) return 0

  const producerElapsed = Math.max(0, sampledAt - input.startedAt)
  if (!finite(input.receivedAt) || !Number.isFinite(input.now)) return producerElapsed

  return producerElapsed + Math.max(0, input.now - input.receivedAt)
}

/**
 * Map a producer interval start into the client monotonic domain. This is
 * useful for UI presentation latches that need a stable local start point after
 * the live telemetry frame itself disappears.
 */
export function sessionTelemetryLocalStartedAt(input: SessionTelemetryClockInput) {
  if (!finite(input.startedAt)) return undefined
  const sampledAt = finite(input.sampledAt) ? input.sampledAt : input.updatedAt
  if (!finite(sampledAt)) return undefined

  const receivedAt = finite(input.receivedAt) ? input.receivedAt : input.now
  if (!Number.isFinite(receivedAt)) return undefined
  return receivedAt - Math.max(0, sampledAt - input.startedAt)
}