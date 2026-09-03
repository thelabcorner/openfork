import { colorFor } from "./usage-gauge-v2"

export type UsageTone = "danger" | "warning" | "success"

// Tiers on the absolute number of requests still available for a model.
export const stretchTone = (requests: number): UsageTone => {
  if (requests <= 8) return "danger"
  if (requests <= 40) return "warning"
  return "success"
}

// Fixed request domain keeps the same model visually stable across virtualized
// windows without scanning the full catalog to discover a relative maximum.
const referenceRequests = 20_000
const logReferenceRequests = Math.log1p(referenceRequests)

/**
 * Compact usage signal shared by model rows and account rows. Providers with
 * a real percentage limit use it directly; request headroom uses a fixed log
 * scale because estimates span several orders of magnitude.
 */
export function ModelStretchBar(props: {
  requests: number
  remainingPercent?: number
  tone?: UsageTone
}) {
  const fraction = () => {
    if (props.remainingPercent !== undefined) return Math.max(0, Math.min(1, props.remainingPercent / 100))
    if (!Number.isFinite(props.requests)) return 1
    const value = Math.log1p(Math.max(0, props.requests)) / logReferenceRequests
    return Math.max(0, Math.min(1, value))
  }
  const color = () => colorFor(props.tone ?? stretchTone(props.requests))

  return (
    <span class="flex h-3 w-7 shrink-0 items-center overflow-hidden rounded-full bg-v2-background-bg-layer-03">
      <span
        class="h-full rounded-full transition-[width] duration-300"
        style={{ width: `${fraction() * 100}%`, "background-color": color() }}
      />
    </span>
  )
}
