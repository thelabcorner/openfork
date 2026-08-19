/**
 * Row-size priority chain (PRETEXT PREDICTS, THE DOM DECIDES).
 *
 * Monotonic toward stronger evidence — never downgrade once a real
 * measurement exists:
 *
 *   1. current measurement (same row key)
 *   2. historical measurement (same content, similar width bucket)
 *   3. deterministic fixed height (row types with constant layout)
 *   4. pretext prediction (eligible text)
 *   5. row-type EWMA prior
 *   6. fallback
 *
 * Every step degrades safely: prediction failures fall through to the prior,
 * and the prior/fallback always return a sane number.
 */

import { estimateTextHeight, type TextTypography } from "@/lib/text-layout"
import type { TimelineRow } from "../timeline-row"
import { isEligibleText } from "./eligibility"
import type { EstimateSource } from "./instrumentation"

export const TIMELINE_FALLBACK_SIZE = 60

/** Deterministic fixed heights (px) for rows whose layout never varies. */
const FIXED_HEIGHTS: Partial<Record<TimelineRow.TimelineRow["_tag"], number>> = {
  TurnGap: 24,
}

export type RowEstimateInput = {
  key: string
  row: TimelineRow.TimelineRow
  /** Stable text content for pretext/history (only when eligible). */
  text?: string
  /** Advisory precomputed height hint (e.g. markdown hint from rows.ts).
   * Used at the pretext tier — still advisory, DOM measurement outranks it. */
  heightHint?: number
  /** Streaming rows are never pretext-eligible but still carry history. */
  streaming?: boolean
}

export type RowEstimateContext = {
  measured: (key: string) => number | undefined
  history: (row: TimelineRow.TimelineRow, text: string | undefined, widthPx: number) => number | undefined
  fixed: (row: TimelineRow.TimelineRow) => number | undefined
  pretext: (text: string, widthPx: number) => number | undefined
  prior: (row: TimelineRow.TimelineRow) => number | undefined
  widthPx: () => number
  fallback: number
}

export function estimateRowSize(input: RowEstimateInput, context: RowEstimateContext): {
  size: number
  source: EstimateSource
} {
  const measured = context.measured(input.key)
  if (measured !== undefined) return { size: measured, source: "measured" }

  const widthPx = context.widthPx()
  const history = context.history(input.row, input.text, widthPx)
  if (history !== undefined) return { size: history, source: "history" }

  const fixed = context.fixed(input.row)
  if (fixed !== undefined) return { size: fixed, source: "fixed" }

  // The markdown heightHint is a projection-time prediction (same tier as
  // pretext, still advisory) — prefer it over live pretext since it already
  // models markdown structure that the plain-text pass cannot. Streaming rows
  // are never hint-eligible: their text (and hint) changes every delta, so a
  // hint would cause the virtualizer to pre-size against a moving target and
  // remount the row. Only stable/completed rows get a prediction.
  if (!input.streaming && input.heightHint !== undefined && input.heightHint > 0) {
    return { size: input.heightHint, source: "pretext" }
  }

  if (!input.streaming && input.text && isEligibleText(input.text)) {
    const pretext = context.pretext(input.text, widthPx)
    if (pretext !== undefined) return { size: pretext, source: "pretext" }
  }

  const prior = context.prior(input.row)
  if (prior !== undefined) return { size: prior, source: "prior" }

  return { size: context.fallback, source: "fallback" }
}

export function fixedRowHeight(row: TimelineRow.TimelineRow) {
  return FIXED_HEIGHTS[row._tag]
}

export function pretextRowHeight(
  text: string,
  widthPx: number,
  typography: TextTypography,
) {
  return estimateTextHeight(text, typography, widthPx)
}
