/**
 * Pretext-backed row-height estimator for the virtualized session timeline
 * (PRETEXT PREDICTS, THE DOM DECIDES).
 *
 * The estimator owns the priority chain state:
 *   - current measurements keyed by row key (fed by measureElement /
 *     ResizeObserver through `observe`)
 *   - width-bucketed history of measured heights per content
 *   - per-row-type EWMA priors
 *   - the shared prepared-text cache (via @/lib/text-layout)
 *
 * The virtualizer's `estimateSize` consults the chain; the DOM's measured
 * height always outranks every prediction (monotonic, never downgraded).
 */

import { estimateTextHeight, textLayoutMode, type TextTypography } from "@/lib/text-layout"
import type { TimelineRow } from "../timeline-row"
import { estimateRowSize, TIMELINE_FALLBACK_SIZE, type RowEstimateInput } from "./estimate-row-size"
import { fixedRowHeight } from "./estimate-row-size"
import { EstimatorInstrumentation, type EstimateRecord, type EstimateSource } from "./instrumentation"
import { MeasurementHistory } from "./measurement-history"
import { RowTypePriors } from "./priors"

export type { EstimateRecord, EstimateSource }
export { TIMELINE_FALLBACK_SIZE }
export type { RowEstimateInput } from "./estimate-row-size"

export const TIMELINE_TYPOGRAPHY: TextTypography = {
  family: '"Segoe UI", system-ui, sans-serif',
  fontSizePx: 14,
  lineHeightPx: 22.4,
  fontWeight: 400,
  fontStyle: "normal",
  letterSpacingPx: 0,
}

export class TimelineRowEstimator {
  private readonly measurements = new Map<string, number>()
  private readonly history = new MeasurementHistory()
  private readonly priors = new RowTypePriors()
  private readonly instrumentation: EstimatorInstrumentation
  private readonly fallback: number
  private readonly typography: TextTypography
  private readonly mode: ReturnType<typeof textLayoutMode>
  private widthPx = 0
  /** Bound per-row measurements so long sessions never leak row keys. */
  private readonly maxMeasurements = 8192

  constructor(options?: {
    fallback?: number
    typography?: TextTypography
    mode?: ReturnType<typeof textLayoutMode>
    instrument?: boolean
  }) {
    this.fallback = options?.fallback ?? TIMELINE_FALLBACK_SIZE
    this.typography = options?.typography ?? TIMELINE_TYPOGRAPHY
    this.mode = options?.mode ?? textLayoutMode()
    this.instrumentation = new EstimatorInstrumentation({ enabled: options?.instrument })
  }

  /** Track the timeline content width once (ResizeObserver, not per-row). */
  setWidth(widthPx: number) {
    this.widthPx = widthPx
  }

  estimateSize(input: RowEstimateInput) {
    // "off" = fully inert: byte-identical to the un-flagged build (the
    // virtualizer's own DOM measurement still corrects each row).
    if (this.mode === "off") return this.fallback
    const { size, source } = estimateRowSize(input, {
      measured: (key) => this.measurements.get(key),
      history: (row, text, width) => this.history.get(row._tag, text, width),
      fixed: fixedRowHeight,
      pretext: (text, width) => estimateTextHeight(text, this.typography, width),
      prior: (row) => this.priors.get(row._tag),
      widthPx: () => this.widthPx,
      fallback: this.fallback,
    })
    this.instrumentation.record(input.key, { source, size })
    return size
  }

  /**
   * Feed a real measured height back (from measureElement / ResizeObserver).
   * Measurement is the strongest evidence and is never downgraded.
   */
  observe(input: {
    key: string
    row: TimelineRow.TimelineRow
    text?: string
    height: number
  }) {
    if (!Number.isFinite(input.height) || input.height <= 0) return
    this.measurements.set(input.key, input.height)
    if (this.measurements.size > this.maxMeasurements) {
      this.measurements.delete(this.measurements.keys().next().value!)
    }
    this.priors.observe(input.row._tag, input.height)
    this.history.observe(input.row._tag, input.text, this.widthPx, input.height)
  }

  /** Debug surface; only populated when instrumentation is enabled. */
  recordFor(key: string) {
    return this.instrumentation.get(key)
  }

  clear() {
    this.measurements.clear()
    this.history.clear()
    this.instrumentation.clear()
  }
}
