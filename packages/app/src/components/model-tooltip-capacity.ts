/**
 * View model for the model inspector's REQUEST CAPACITY section.
 *
 * The server publishes, per quota window, a full-window TOTAL capacity point and
 * — separately and only where it really observed them — the requests still left
 * in that window. Those are different quantities and the section keeps them
 * visibly apart: the total is the headline, the remaining count is subordinate.
 *
 * Two things this module deliberately does NOT do:
 *
 *  - invent a window the server did not report, or scale a 5-hour figure up into
 *    a weekly one;
 *  - fall back to the deployed predictive range for a window total. That range is
 *    a 5h remaining/stopping-time calibration and was never validated for window
 *    totals (see capacity-window-range for the band the section draws instead).
 *  - turn a remaining PERCENTAGE into a request count. The count is the field
 *    that fails closed, so a percent-only window renders the percentage on its
 *    own row rather than borrowing or deriving a number the owner never sent.
 */

/** Em dash used for "the owner has no answer for this cell". */
export const CAPACITY_DASH = "—"

/** Window identities the inspector renders, in display order. */
export const CAPACITY_WINDOW_KINDS = ["5h", "week"] as const
export type CapacityWindowKind = (typeof CAPACITY_WINDOW_KINDS)[number]

/** Structurally compatible with `ForkCapacityPredictiveRange`. */
export type CapacityRangeInput =
  | { status: "calibrated"; effectiveSamples?: number; lowerRequests?: number; upperRequests?: number; calibrationBudget?: number }
  | { status: "learning"; effectiveSamples?: number; calibrationBudget?: number }
  | { status: "unavailable"; effectiveSamples?: number; reason?: string; calibrationBudget?: number }
  | { status: "ready"; effectiveSamples?: number; calibrationBudget?: number }

/** What a remaining-count cell shows. */
export type CapacityRangeView =
  | { state: "calibrated"; lower: number; upper: number; point?: number; samples?: number; budget?: number }
  | { state: "ready"; point: number; samples?: number; budget?: number }
  | { state: "learning"; samples?: number; budget?: number }
  | { state: "unavailable"; reason?: string }

/** What a window-total cell shows. */
export type CapacityTotalView = { point: number; lower: number; upper: number }

/**
 * One normalized window as published by the transport boundary (`CapacityWindow`
 * in `@/context/fork-usage`). Structural rather than imported so the view model
 * stays testable without mounting the Solid context.
 */
export type CapacityWindowInput = {
  /** Stable window key; also the owner's display label. */
  id: string
  label?: string
  /**
   * The published full-window TOTAL. The headline range is drawn from this value
   * rescaled through the user's own workload; when it is absent the window can
   * still show an observed remainder, and never a band.
   */
  pointRequests?: number
  /** Published only where the owner really observed this window's consumption. */
  remaining?: {
    remainingPercent?: number
    /** Requests left; absent/null means local accounting failed closed. */
    remainingRequests?: number | null
    resetAt?: number
    status?: "ready" | "unavailable"
  } | null
}

export type CapacityWindowView = {
  kind: CapacityWindowKind
  /** Full-window total capacity; absent when no band could be drawn. */
  total?: CapacityTotalView
  /** Requests still left in this window — always subordinate to `total`. */
  remaining?: CapacityRangeView
  /**
   * Fraction of the window still left, as the owner published it. Independent of
   * `remaining`: the owner may report the share while its local accounting failed
   * closed on the count (see `capacityPercentOnly`).
   */
  remainingPercent?: number
}

export type CapacityLearningView = { samples?: number; budget?: number }

export type CapacitySectionView = {
  windows: CapacityWindowView[]
  hasCapacity: boolean
  /** Priced corpus samples behind every drawn band, for the tooltip's hint. */
  bandSamples?: number
  learning?: CapacityLearningView
  /** Why a window has no answer, when the owner said so. */
  unavailableReason?: string
}

/** One drawn band, keyed by the server's own window id. */
export type CapacityBandInput = {
  window: string
  point: number
  lower: number
  upper: number
  remaining?: number
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

/**
 * Map a server window id onto a row the inspector knows how to draw.
 *
 * Only ids the owner actually publishes are accepted. An unknown id is dropped
 * rather than guessed at, so a future `month` window cannot silently render as
 * a week.
 */
export function capacityWindowKindFor(label: string | null | undefined): CapacityWindowKind | undefined {
  if (typeof label !== "string") return undefined
  const value = label.trim().toLowerCase()
  if (value === "5h" || value === "5hr" || value === "5hour" || value === "5hours" || value === "fivehour") return "5h"
  if (value === "week" || value === "weekly" || value === "7d" || value === "168h") return "week"
  return undefined
}

/**
 * Collapse the owner's remaining range + point count into one cell.
 *
 * An owner-declared `unavailable` always wins over a point estimate: printing a
 * number next to "we cannot normalize this" is how an estimate becomes a
 * promise.
 */
export function resolveCapacityRange(
  range: CapacityRangeInput | null | undefined,
  point: number | null | undefined,
): CapacityRangeView {
  const pointValue = isFiniteNumber(point) ? point : undefined
  if (range && typeof range === "object") {
    const samples = isFiniteNumber(range.effectiveSamples) ? range.effectiveSamples : undefined
    const budget = isFiniteNumber(range.calibrationBudget) ? range.calibrationBudget : undefined
    const tail = {
      ...(samples !== undefined ? { samples } : {}),
      ...(budget !== undefined ? { budget } : {}),
    }
    switch (range.status) {
      case "calibrated": {
        const lower = isFiniteNumber(range.lowerRequests) ? range.lowerRequests : undefined
        const upper = isFiniteNumber(range.upperRequests) ? range.upperRequests : undefined
        // A calibrated label with an unpaired bound is not a range. Fall through
        // to the point count instead of printing half a band.
        if (lower !== undefined && upper !== undefined)
          return {
            state: "calibrated",
            lower: Math.min(lower, upper),
            upper: Math.max(lower, upper),
            ...(pointValue !== undefined ? { point: pointValue } : {}),
            ...tail,
          }
        break
      }
      case "learning":
        return { state: "learning", ...tail }
      case "unavailable":
        return { state: "unavailable", ...(range.reason ? { reason: range.reason } : {}) }
      default:
        break
    }
  }
  if (pointValue !== undefined) {
    const samples = range && isFiniteNumber(range.effectiveSamples) ? range.effectiveSamples : undefined
    const budget = range && isFiniteNumber(range.calibrationBudget) ? range.calibrationBudget : undefined
    return {
      state: "ready",
      point: pointValue,
      ...(samples !== undefined ? { samples } : {}),
      ...(budget !== undefined ? { budget } : {}),
    }
  }
  return { state: "unavailable" }
}

function bandFor(bands: readonly CapacityBandInput[], kind: CapacityWindowKind): CapacityTotalView | undefined {
  const window = CAPACITY_WINDOW_KINDS.find((candidate) => candidate === kind)
  const match = bands.find((band) => capacityWindowKindFor(band.window) === window)
  if (!match) return undefined
  const { point, lower, upper } = match
  if (!isFiniteNumber(point) || !isFiniteNumber(lower) || !isFiniteNumber(upper)) return undefined
  // The band must contain its own point, whatever the caller computed.
  return { point, lower: Math.min(lower, point), upper: Math.max(upper, point) }
}

/**
 * Build the REQUEST CAPACITY rows.
 *
 * Drawn bands lead; the remaining count follows as a subordinate row for the
 * same window. When the server published no window totals and no band can be
 * drawn, the single 5-hour remaining estimate stands alone — that is exactly
 * what it measures, and it is not rescaled into a week.
 */
export function resolveCapacitySection(input: {
  windows?: readonly (CapacityWindowInput | null | undefined)[] | null
  /** Drawn full-window bands from the shared pricing math. */
  bands?: readonly CapacityBandInput[] | null
  bandSamples?: number
  estimatedRequests?: number | null
  predictiveRange?: CapacityRangeInput | null
  status?: "ready" | "learning" | "unavailable" | "unlimited" | undefined
}): CapacitySectionView {
  if (input.status === "unlimited") return { windows: [], hasCapacity: false }

  const bands = input.bands ?? []
  const views: CapacityWindowView[] = []
  const seen = new Set<CapacityWindowKind>()

  for (const window of input.windows ?? []) {
    if (!window) continue
    const kind = capacityWindowKindFor(window.id)
    if (!kind || seen.has(kind)) continue
    const band = bandFor(bands, kind)
    const bandRemaining = bands.find((entry) => capacityWindowKindFor(entry.window) === kind)?.remaining
    const observedRemaining = window.remaining?.remainingRequests
    const remainingSource = isFiniteNumber(observedRemaining)
      ? observedRemaining
      : isFiniteNumber(bandRemaining)
        ? bandRemaining
        : undefined
    const remaining = resolveCapacityRange(undefined, remainingSource)
    const observedPercent = window.remaining?.remainingPercent
    const hasFact = !!band || remaining.state !== "unavailable" || isFiniteNumber(observedPercent)
    if (!hasFact) continue
    seen.add(kind)
    views.push({
      kind,
      ...(band ? { total: band } : {}),
      ...(remaining.state !== "unavailable" ? { remaining } : {}),
      ...(isFiniteNumber(observedPercent) ? { remainingPercent: observedPercent } : {}),
    })
  }
  views.sort((a, b) => CAPACITY_WINDOW_KINDS.indexOf(a.kind) - CAPACITY_WINDOW_KINDS.indexOf(b.kind))

  if (
    views.length === 0 &&
    (isFiniteNumber(input.estimatedRequests) || !!input.predictiveRange || input.status === "learning" || input.status === "unavailable")
  ) {
    let remaining: CapacityRangeView
    if (input.predictiveRange) remaining = resolveCapacityRange(input.predictiveRange, input.estimatedRequests)
    else if (input.status === "learning") remaining = { state: "learning" }
    else if (input.status === "unavailable") remaining = { state: "unavailable" }
    else remaining = resolveCapacityRange(undefined, input.estimatedRequests)
    views.push({ kind: "5h", remaining })
  }

  const learning = views.map((view) => view.remaining).find((range) => range?.state === "learning")
  const unavailable = views.map((view) => view.remaining).find((range) => range?.state === "unavailable")
  return {
    windows: views,
    hasCapacity: views.length > 0,
    ...(isFiniteNumber(input.bandSamples) ? { bandSamples: input.bandSamples } : {}),
    ...(learning && learning.state === "learning"
      ? {
          learning: {
            ...(learning.samples !== undefined ? { samples: learning.samples } : {}),
            ...(learning.budget !== undefined ? { budget: learning.budget } : {}),
          },
        }
      : {}),
    ...(unavailable && unavailable.state === "unavailable" && unavailable.reason
      ? { unavailableReason: unavailable.reason }
      : {}),
  }
}

/**
 * The percentage a window has left to show by itself, or `undefined` when the
 * count already carries it.
 *
 * `remainingPercent` and `remaining` are separate facts and the count is the one
 * that fails closed, so a window can arrive with a real percentage and no count.
 * Such a window still draws a dense percent-only row; the alternative — dropping
 * the percentage because its count is missing — is how the section renders empty
 * while the owner is publishing an answer.
 */
export function capacityPercentOnly(window: CapacityWindowView): number | undefined {
  if (window.remaining !== undefined) return undefined
  return isFiniteNumber(window.remainingPercent) ? window.remainingPercent : undefined
}

const COMPACT_THRESHOLD = 10_000
const percentFormatterCache = new Map<string, Intl.NumberFormat>()
function percentFormatter(locale: string | undefined): Intl.NumberFormat {
  const key = locale ?? ""
  const cached = percentFormatterCache.get(key)
  if (cached) return cached
  const formatter = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 })
  percentFormatterCache.set(key, formatter)
  return formatter
}
const requestFormatterCache = new Map<string, Intl.NumberFormat>()
function requestFormatter(locale: string | undefined, compact: boolean): Intl.NumberFormat {
  const key = `${locale ?? ""}|${compact ? "c" : "p"}`
  const cached = requestFormatterCache.get(key)
  if (cached) return cached
  const formatter = new Intl.NumberFormat(
    locale,
    compact ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: 0 },
  )
  requestFormatterCache.set(key, formatter)
  return formatter
}

/**
 * Request counts stay exact while they fit, then compact. An inspector column
 * that wraps `15,240` onto a second line is worse than `15.2K`, but rounding
 * `540` to `540` is free and reads as a measurement.
 */
export function formatRequestCount(value: number | null | undefined, locale?: string): string {
  if (!isFiniteNumber(value)) return CAPACITY_DASH
  return requestFormatter(locale, Math.abs(value) >= COMPACT_THRESHOLD).format(value)
}

/** `2.4K–10.4K` for a window total, `540` when only one figure is drawable. */
export function formatRequestRange(range: CapacityRangeView, locale?: string): string {
  if (range.state === "calibrated")
    return `${formatRequestCount(range.lower, locale)}–${formatRequestCount(range.upper, locale)}`
  if (range.state === "ready") return formatRequestCount(range.point, locale)
  return CAPACITY_DASH
}

/** The headline point, printed quietly because a band already leads it. */
export function formatRequestPointEstimate(total: CapacityTotalView, locale?: string): string {
  return formatRequestCount(total.point, locale)
}

/** `42%` — the whole answer for a window that published a share but no count. */
export function formatRemainingPercent(percent: number | null | undefined, locale?: string): string {
  if (!isFiniteNumber(percent)) return CAPACITY_DASH
  return percentFormatter(locale).format(percent / 100)
}