// Token-bucket guard for the synchronous electron-log file transport.
//
// The file transport appends with fs.writeFileSync on the Electron main
// thread. Sidecar stdout/stderr lines and spied renderer console output all
// land here; under concurrent sessions that is hundreds of lines/sec, each a
// sync filesystem append (often AV-scanned on Windows). Enabling the
// transport's async option instead would create an UNBOUNDED write queue, so
// the robust fix is shedding at the transport: bursts pass, sustained floods
// are dropped with exact accounting, and error/warn signal always passes.
//
// Pure module (no electron import) so it stays unit-testable under bun.

export interface LogThrottleOptions {
  /** Maximum lines admitted in an instantaneous burst. */
  burst: number
  /** Sustained admission rate in lines per second. */
  ratePerSec: number
}

export interface ThrottleVerdict {
  /** Whether the line may be written. */
  pass: boolean
  /**
   * Lines dropped since the last passing line. Caller contract: when a line
   * passes with suppressed > 0, emit one summary line first, then the line.
   * Always 0 on dropped lines.
   */
  suppressed: number
}

// Severity that always passes: dropping errors/warnings would hide the exact
// signal needed to diagnose the overload being shed.
const PASSTHROUGH_LEVELS = new Set(["error", "warn"])

export function createLogThrottle(options: LogThrottleOptions) {
  if (!Number.isFinite(options.burst) || options.burst < 0) {
    throw new Error(`log throttle burst must be a non-negative number, got ${options.burst}`)
  }
  if (!Number.isFinite(options.ratePerSec) || options.ratePerSec < 0) {
    throw new Error(`log throttle ratePerSec must be a non-negative number, got ${options.ratePerSec}`)
  }
  let tokens = options.burst
  let last = 0
  let suppressed = 0

  const takeSuppressed = () => {
    const pending = suppressed
    suppressed = 0
    return pending
  }

  return {
    guard(level: string, now: number = Date.now()): ThrottleVerdict {
      if (PASSTHROUGH_LEVELS.has(level)) return { pass: true, suppressed: takeSuppressed() }
      if (last === 0) {
        last = now
      } else {
        const elapsedMs = Math.max(0, now - last)
        last = now
        tokens = Math.min(options.burst, tokens + (elapsedMs * options.ratePerSec) / 1000)
      }
      if (tokens >= 1) {
        tokens -= 1
        return { pass: true, suppressed: takeSuppressed() }
      }
      suppressed += 1
      return { pass: false, suppressed: 0 }
    },
  }
}

export type LogThrottle = ReturnType<typeof createLogThrottle>
