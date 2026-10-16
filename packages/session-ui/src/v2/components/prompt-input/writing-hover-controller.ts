import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { WritingHoverBadgeValue } from "./writing-hover-badge"
import type { createPromptWritingHighlights } from "./writing-highlights"

type HighlightEngine = ReturnType<typeof createPromptWritingHighlights>
type Item = {
  id: string
  original: string
  replacement?: string
  category?: "spelling" | "grammar"
}

/**
 * One pointer hit-test per animation frame at most, even on high-Hz mice.
 * No layout measurements, listeners or timers are installed while idle.
 * The hover chip lives outside contenteditable and never changes text/selection.
 */
export function createWritingHoverController(input: {
  highlights: HighlightEngine
  enabled: () => boolean
  corrected: () => readonly Item[]
  issues: () => readonly Item[]
}) {
  const [hover, setHover] = createSignal<WritingHoverBadgeValue>()
  let frame: number | undefined
  let leaveTimer: ReturnType<typeof setTimeout> | undefined
  let point: { x: number; y: number } | undefined

  const clearTimer = () => {
    if (leaveTimer === undefined) return
    clearTimeout(leaveTimer)
    leaveTimer = undefined
  }
  const clear = () => {
    point = undefined
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    clearTimer()
    setHover(undefined)
  }
  const item = createMemo(() => {
    const current = hover()
    if (!current || !input.enabled()) return undefined
    return (current.kind === "corrected" ? input.corrected() : input.issues())
      .find((candidate) => candidate.id === current.id)
  })

  const onMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return
    if (!input.enabled()) return clear()
    clearTimer()
    point = { x: event.clientX, y: event.clientY }
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (!point || !input.enabled()) return clear()
      const hit = input.highlights.hoverAtPoint(point.x, point.y)
      if (!hit) return setHover(undefined)
      const selected = (hit.kind === "corrected" ? input.corrected() : input.issues())
        .find((candidate) => candidate.id === hit.id)
      if (!selected) return setHover(undefined)
      const width = Math.min(292, window.innerWidth - 16)
      const x = Math.max(8, Math.min(
        window.innerWidth - width - 8,
        (hit.rect.left + hit.rect.right - width) / 2,
      ))
      const y = hit.rect.top > 46 ? hit.rect.top - 37 :
        Math.min(window.innerHeight - 38, hit.rect.bottom + 8)
      const current = hover()
      if (current?.id === hit.id && current.kind === hit.kind &&
        current.x === x && current.y === y &&
        current.original === selected.original && current.replacement === selected.replacement) return
      setHover({
        kind: hit.kind, id: hit.id, original: selected.original,
        replacement: selected.replacement, category: selected.category, x, y,
      })
    })
  }

  const onLeave = () => {
    clearTimer()
    leaveTimer = setTimeout(clear, 175)
  }
  const onEnterBadge = () => clearTimer()
  const onLeaveBadge = () => clear()

  createEffect(() => {
    if (!input.enabled()) clear()
  })

  createEffect(() => {
    if (!hover()) return
    // Layout/scroll can move Range rectangles even without text edits.
    // Tear down the transient overlay rather than showing an X on the wrong word.
    window.addEventListener("scroll", clear, true)
    window.addEventListener("resize", clear, { passive: true })
    onCleanup(() => {
      window.removeEventListener("scroll", clear, true)
      window.removeEventListener("resize", clear)
    })
  })

  onCleanup(clear)
  return { hover, item, onMove, onLeave, onEnterBadge, onLeaveBadge, clear }
}
