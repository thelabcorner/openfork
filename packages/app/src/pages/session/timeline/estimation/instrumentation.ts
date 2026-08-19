/**
 * Estimator instrumentation (PRETEXT PREDICTS, THE DOM DECIDES).
 *
 * Debug fields never live on the hot path: `estimateSize` returns a plain
 * number; source/error attribution is recorded into a bounded side table that
 * callers opt into reading. Tracking is off by default so flag-"off" builds
 * pay zero cost.
 */

export type EstimateSource =
  | "measured"
  | "history"
  | "fixed"
  | "pretext"
  | "prior"
  | "fallback"

export type EstimateRecord = {
  source: EstimateSource
  /** Height the estimator returned. */
  size: number
  /** Set when the pretext path failed and we degraded. */
  error?: string
}

export class EstimatorInstrumentation {
  private readonly records = new Map<string, EstimateRecord>()
  private readonly enabled: boolean

  constructor(options?: { enabled?: boolean }) {
    this.enabled = options?.enabled ?? false
  }

  get isEnabled() {
    return this.enabled
  }

  record(key: string, record: EstimateRecord) {
    if (!this.enabled) return
    // Bounded: only keep the most recent N rows to avoid unbounded growth in
    // long sessions. Records are keyed by row key, which is already unique.
    if (this.records.size >= 2048 && !this.records.has(key)) {
      this.records.delete(this.records.keys().next().value!)
    }
    this.records.set(key, record)
  }

  get(key: string) {
    return this.records.get(key)
  }

  clear() {
    this.records.clear()
  }
}
