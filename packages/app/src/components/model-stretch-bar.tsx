import { colorForTone, toneForRemaining } from "@/utils/limits-format"

export type UsageTone = "danger" | "warning" | "success" | "muted"

/**
 * Tiers on the absolute number of requests still available for a model.
 *
 * Only ever call this with a real measured count. A missing estimate is NOT
 * zero requests — `stretchHeadroom` keeps that case as `unknown` so no caller
 * has to invent a number to reach a tone.
 */
export const stretchTone = (requests: number): UsageTone => {
  if (requests <= 8) return "danger"
  if (requests <= 40) return "warning"
  return "success"
}

// Fixed request domain keeps the same model visually stable across virtualized
// windows without scanning the full catalog to discover a relative maximum.
const referenceRequests = 20_000
const logReferenceRequests = Math.log1p(referenceRequests)

export type StretchHeadroomState = "percent" | "requests" | "unlimited" | "unknown"

export type StretchHeadroom = {
  /**
   * 0..1 fill, or `null` when there is no measured headroom behind this row.
   * `null` means "draw no bar" — never "draw an empty one", which reads as a
   * depleted quota.
   */
  readonly fraction: number | null
  readonly tone: UsageTone
  readonly state: StretchHeadroomState
}

/**
 * Resolve one row's usage bar from the two independently optional facts the
 * server projects.
 *
 * Precedence and degradation rules:
 * - `remainingPercent` is authoritative when it is a real number: it comes from
 *   an actual quota/resource denominator.
 * - A finite `requests` estimate is next; `Infinity` is a genuine "unlimited"
 *   claim and fills the bar.
 * - Anything else (`undefined`, `NaN`) is `unknown`. Capacity reports exactly
 *   this for `learning` and `unavailable` rows, so those must render as an
 *   indeterminate/neutral no-bar rather than a red empty "0 left".
 */
export function stretchHeadroom(input: {
  requests?: number
  remainingPercent?: number
  /** Pre-computed override (for rows whose tone comes from another owner). */
  tone?: UsageTone
}): StretchHeadroom {
  const remaining = input.remainingPercent
  if (remaining !== undefined && Number.isFinite(remaining))
    return {
      fraction: Math.max(0, Math.min(1, remaining / 100)),
      tone: input.tone ?? toneForRemaining(remaining),
      state: "percent",
    }

  const requests = input.requests
  if (requests === undefined || Number.isNaN(requests))
    return { fraction: null, tone: input.tone ?? "muted", state: "unknown" }
  if (!Number.isFinite(requests))
    return { fraction: 1, tone: input.tone ?? "success", state: "unlimited" }

  return {
    fraction: Math.max(0, Math.min(1, Math.log1p(Math.max(0, requests)) / logReferenceRequests)),
    tone: input.tone ?? stretchTone(requests),
    state: "requests",
  }
}

/**
 * Compact usage signal shared by model rows and account rows. Providers with
 * a real percentage limit use it directly; request headroom uses a fixed log
 * scale because estimates span several orders of magnitude.
 */
export function ModelStretchBar(props: {
  /** Absent when Capacity has no request estimate (learning/unavailable). */
  requests?: number
  remainingPercent?: number
  tone?: UsageTone
}) {
  const headroom = () => stretchHeadroom(props)
  const fill = () => {
    const fraction = headroom().fraction
    return fraction === null ? null : (
      <span
        class="h-full rounded-full transition-[width] duration-300"
        style={{ width: `${fraction * 100}%`, "background-color": colorForTone(headroom().tone) }}
      />
    )
  }

  return (
    <span
      class="flex h-3 w-7 shrink-0 items-center overflow-hidden rounded-full bg-v2-background-bg-layer-03"
      data-stretch-state={headroom().state}
    >
      {fill()}
    </span>
  )
}
