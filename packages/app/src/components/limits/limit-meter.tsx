import { createMemo } from "solid-js"
import { colorForTone, toneForRemaining } from "@/utils/limits-format"

export type Tone = ReturnType<typeof toneForRemaining>

/**
 * Shared between the Limits pane and the composer's limit arc hover card so
 * the same number is drawn the same way in both places. Previously the meter
 * lived privately inside `limits-panel.tsx`; the arc's card would have had to
 * re-implement the mask recipe, and the two would have drifted the first time
 * either was tuned.
 */
export function ToneDot(props: { tone: Tone; pulse?: boolean }) {
  return (
    <span
      class="inline-flex size-1.5 shrink-0 rounded-full"
      classList={{ "animate-pulse": !!props.pulse }}
      style={{ "background-color": colorForTone(props.tone) }}
      aria-hidden="true"
    />
  )
}

/**
 * One element, not one-per-segment — the "drained" look is a static CSS mask
 * (painted once, zero reactive cost); the only thing that updates per data
 * change is a single two-stop gradient marking the boundary. Drains
 * left→right: the lit color is pinned to the right edge and the dark/drained
 * region eats in from the left as `remaining` falls — it never grows toward
 * "full".
 */
export function DrainMeter(props: { remaining: number | null; tone: Tone; dense?: boolean; width?: number }) {
  const boundary = createMemo(() => {
    const r = props.remaining
    if (r === null || r === undefined || !Number.isFinite(r)) return 100
    const clamped = Math.max(0, Math.min(100, r))
    if (clamped <= 0) return 100
    return Math.min(98, 100 - clamped)
  })

  return (
    <div
      class="shrink-0 rounded-[1px] [mask-image:repeating-linear-gradient(to_right,#000_0,#000_3px,transparent_3px,transparent_5px)] [-webkit-mask-image:repeating-linear-gradient(to_right,#000_0,#000_3px,transparent_3px,transparent_5px)]"
      classList={{ "h-2.5": props.dense, "h-3": !props.dense }}
      style={{
        width: `${props.width ?? 64}px`,
        background: `linear-gradient(to right, var(--v2-background-bg-layer-03) ${boundary()}%, ${colorForTone(props.tone)} ${boundary()}%)`,
        opacity: props.remaining === null ? 0.4 : 1,
      }}
      aria-hidden="true"
    />
  )
}
