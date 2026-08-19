/**
 * Per-row-type EWMA priors fed by real measurements (PRETEXT PREDICTS, THE DOM
 * DECIDES). Each observed height for a row type nudges that type's prior; the
 * prior is used only when stronger evidence (measured/history/fixed/pretext)
 * is unavailable, and always below the fallback's role of last resort.
 *
 * Kept deliberately small: one number per row type, no per-row state.
 */

import type { TimelineRow } from "../timeline-row"

export type RowType = TimelineRow.TimelineRow["_tag"]

const EWMA_ALPHA = 0.25

export class RowTypePriors {
  private readonly values = new Map<RowType, number>()
  private readonly counts = new Map<RowType, number>()

  observe(type: RowType, height: number) {
    if (!Number.isFinite(height) || height <= 0) return
    const previous = this.values.get(type)
    const count = (this.counts.get(type) ?? 0) + 1
    this.counts.set(type, count)
    if (previous === undefined) {
      this.values.set(type, height)
      return
    }
    this.values.set(type, previous * (1 - EWMA_ALPHA) + height * EWMA_ALPHA)
  }

  /** The EWMA prior for a row type, or undefined until first observation. */
  get(type: RowType) {
    return this.values.get(type)
  }

  sampleCount(type: RowType) {
    return this.counts.get(type) ?? 0
  }
}
