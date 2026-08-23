import { onCleanup, splitProps, type JSX } from "solid-js"
import {
  clampDelta,
  clampGroupDelta,
  distributeGroupDelta,
  pairedWidths,
  type GroupDistributionMode,
} from "../utils/pane-geometry"

export interface ResizeHandlePairSide {
  size: number
  min: number
  max?: number
  onResize: (size: number) => void
  /** Optional direct DOM element for transient writes (avoids Solid thrash). */
  el?: () => HTMLElement | null | undefined
  /**
   * This pane's width is layout-derived (a `flex: 1` absorber), not stored.
   * It still participates in delta clamping via `size`/`min`, but is never
   * written: flexbox transfers exactly the width the other participant gains
   * or loses, which conserves the pair sum by construction.
   */
  absorb?: boolean
}

export interface ResizeHandleProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "onResize"> {
  direction: "horizontal" | "vertical"
  edge?: "start" | "end"
  size: number
  min: number
  max: number
  onResize: (size: number) => void
  onCollapse?: () => void
  /** Called while dragging when size crosses `collapseThreshold`. */
  onCollapseChange?: (collapsed: boolean) => void
  collapseThreshold?: number
  /** Step size (px) used for keyboard resizing. Defaults to 16. */
  keyboardStep?: number
  /**
   * Anchor-invariant paired mode: divider between two panes. When provided,
   * dragging moves the divider by Δ, growing left by +Δ and shrinking right
   * by -Δ, conserving pair sum. This implements the handoff doc's
   * invariant: "move a boundary while preserving every other boundary".
   * Transient DOM writes are used during drag (rAF coalesced) and the
   * persisted store is committed once at pointerup.
   */
  pair?: {
    /**
     * Either the single adjacent pane, or a group of panes that should share
     * the delta as an even n-way split (delta / n members) instead of only
     * the immediate neighbor. A group is used so that, e.g., resizing the
     * 4th pane in a row redistributes space across every pane between the
     * absorber and the dragged pane rather than just the pane touching it.
     */
    left: ResizeHandlePairSide | ResizeHandlePairSide[]
    right: ResizeHandlePairSide
    /** When `left` is a group: `"equal"` (default) splits delta/n evenly; `"weighted"` splits proportionally by each member's current size. */
    groupMode?: GroupDistributionMode
  }
  /** Optional direct target for single-mode transient writes. */
  targetRef?: () => HTMLElement | null | undefined
}

// Arrow-key step for accessible resizing without a pointer.
const DEFAULT_KEYBOARD_STEP = 16

export function ResizeHandle(props: ResizeHandleProps) {
  const [local, rest] = splitProps(props, [
    "direction",
    "edge",
    "size",
    "min",
    "max",
    "onResize",
    "onCollapse",
    "onCollapseChange",
    "collapseThreshold",
    "keyboardStep",
    "class",
    "classList",
    "pair",
    "targetRef",
  ])

  // Tracks the live drag session so pointercancel/unmount can always find
  // and tear down whatever listeners are currently attached.
  let activePointerId: number | null = null
  let cleanupDrag: (() => void) | null = null

  const resolveEdge = () => local.edge ?? (local.direction === "vertical" ? "start" : "end")

  const clamp = (value: number) => Math.min(local.max, Math.max(local.min, value))

  const handlePointerDown = (e: PointerEvent) => {
    if (e.button !== undefined && e.button !== 0) return
    if (e.detail > 1) return
    e.preventDefault()

    const target = e.currentTarget as HTMLElement
    const edge = resolveEdge()
    const isHorizontal = local.direction === "horizontal"
    const start = isHorizontal ? e.clientX : e.clientY
    const rtl = isHorizontal && getComputedStyle(target).direction === "rtl"
    const threshold = local.collapseThreshold ?? 0
    const onCollapse = local.onCollapse
    const onCollapseChange = local.onCollapseChange

    // Snapshot pair/single geometry ONCE at pointerdown (read-once, write-many)
    const pair = local.pair
    const hasPair = !!pair
    const isGroup = hasPair && Array.isArray(pair.left)
    const groupSides = isGroup ? (pair!.left as ResizeHandlePairSide[]) : null
    let pairLeftStart = hasPair && !isGroup ? (pair!.left as ResizeHandlePairSide).size : 0
    let pairRightStart = hasPair ? pair!.right.size : 0
    const pairLeftMin = hasPair && !isGroup ? (pair!.left as ResizeHandlePairSide).min : 0
    const pairRightMin = hasPair ? pair!.right.min : 0
    const pairLeftMax = hasPair && !isGroup ? (pair!.left as ResizeHandlePairSide).max : undefined
    const pairRightMax = hasPair ? pair!.right.max : undefined
    // Absorbing sides are flex-derived: measured for clamping, never written.
    const pairLeftAbsorb = hasPair && !isGroup ? (pair!.left as ResizeHandlePairSide).absorb === true : false
    const pairRightAbsorb = hasPair ? pair!.right.absorb === true : false
    let startSize = local.size
    // Cache DOM elements once to avoid per-frame queries
    const cachedLeftEl = hasPair && !isGroup ? ((pair!.left as ResizeHandlePairSide).el?.() ?? null) : null
    const cachedRightEl = hasPair ? (pair!.right.el?.() ?? null) : null
    const cachedSingleEl = !hasPair ? (local.targetRef?.() ?? null) : null
    // Group snapshot: measure each member's rendered width/height once.
    const groupEls: (HTMLElement | null)[] = groupSides ? groupSides.map((s) => s.el?.() ?? null) : []
    let groupStart: number[] = groupSides
      ? groupSides.map((s, i) => {
          const el = groupEls[i]
          if (el) {
            const m = isHorizontal ? el.getBoundingClientRect().width : el.getBoundingClientRect().height
            if (m > 0) return m
          }
          return s.size
        })
      : []
    // Read-once (§29): the rendered geometry is authoritative, not the store.
    // An absorbing pane in particular has no stored width at all.
    if (hasPair) {
      if (cachedLeftEl) {
        const m = isHorizontal ? cachedLeftEl.getBoundingClientRect().width : cachedLeftEl.getBoundingClientRect().height
        if (m > 0) pairLeftStart = m
      }
      if (cachedRightEl) {
        const m = isHorizontal ? cachedRightEl.getBoundingClientRect().width : cachedRightEl.getBoundingClientRect().height
        if (m > 0) pairRightStart = m
      }
    } else if (cachedSingleEl) {
      const m = isHorizontal ? cachedSingleEl.getBoundingClientRect().width : cachedSingleEl.getBoundingClientRect().height
      if (m > 0 && Math.abs(m - startSize) < 800) startSize = Math.round(m)
    }

    let current = startSize
    let pairedLeft = pairLeftStart
    let pairedRight = pairRightStart
    let groupValues = groupStart
    let collapsed = false

    // rAF coalescing: one geometry write per frame
    let latestPointer = start
    let framePending = false
    let rafId: number | null = null

    document.body.style.userSelect = "none"
    document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize"

    target.setPointerCapture?.(e.pointerId)
    activePointerId = e.pointerId

    const applySingle = (pointerPos: number) => {
      const delta = isHorizontal
        ? (edge === "start") !== rtl
          ? start - pointerPos
          : pointerPos - start
        : edge === "end"
          ? pointerPos - start
          : start - pointerPos
      current = startSize + delta
      const nextCollapsed = threshold > 0 && current < threshold
      if (nextCollapsed !== collapsed) {
        collapsed = nextCollapsed
        onCollapseChange?.(collapsed)
      }
      if (collapsed) return
      const clamped = clamp(current)
      // Transient DOM write if ref provided (avoids Solid thrash), else direct store write
      if (cachedSingleEl) {
        if (isHorizontal) cachedSingleEl.style.width = `${clamped}px`
        else cachedSingleEl.style.height = `${clamped}px`
      } else {
        local.onResize(clamped)
      }
    }

    const applyGroupPaired = (pointerPos: number) => {
      let requestedDelta = pointerPos - start
      if (isHorizontal && rtl) requestedDelta = -requestedDelta
      if (!isHorizontal && edge === "start") requestedDelta = -requestedDelta
      const groupMembers = groupSides!.map((s, i) => ({ size: groupStart[i], min: s.min, max: s.max }))
      const delta = clampGroupDelta(groupMembers, pairRightMin, pairRightMax, pairRightStart, requestedDelta)
      const nextGroupValues = distributeGroupDelta(groupMembers, delta, pair!.groupMode)
      const nextRight = pairRightStart - delta
      groupValues = nextGroupValues
      pairedRight = nextRight
      const nextCollapsed = threshold > 0 && (nextRight < threshold || nextGroupValues.some((v) => v < threshold))
      if (nextCollapsed !== collapsed) {
        collapsed = nextCollapsed
        onCollapseChange?.(collapsed)
      }
      if (collapsed) return
      groupSides!.forEach((side, i) => {
        const value = nextGroupValues[i]
        const el = groupEls[i]
        if (side.absorb) return
        if (el) {
          if (isHorizontal) el.style.width = `${value}px`
          else el.style.height = `${value}px`
          return
        }
        side.onResize(value)
      })
      if (!pairRightAbsorb) {
        if (cachedRightEl) {
          if (isHorizontal) cachedRightEl.style.width = `${nextRight}px`
          else cachedRightEl.style.height = `${nextRight}px`
        } else {
          pair!.right.onResize(nextRight)
        }
      }
      if (import.meta.env.DEV) {
        const beforeTotal = groupStart.reduce((s, v) => s + v, 0) + pairRightStart
        const afterTotal = nextGroupValues.reduce((s, v) => s + v, 0) + nextRight
        if (Math.abs(beforeTotal - afterTotal) >= 0.5)
          console.warn("[resize] group conservation violated", { beforeTotal, afterTotal, delta })
      }
    }

    const applyPaired = (pointerPos: number) => {
      // Divider delta: physical pointer delta, corrected for RTL so divider visually follows pointer
      // For horizontal: positive when moving toward inline-end (right in LTR, left in RTL)
      let requestedDelta = pointerPos - start
      if (isHorizontal && rtl) requestedDelta = -requestedDelta
      if (!isHorizontal && edge === "start") requestedDelta = -requestedDelta
      const { left, right, delta } = (() => {
        if (pairLeftMax !== undefined || pairRightMax !== undefined) {
          // Use max-aware clamping if either max is defined
          const minD = pairLeftMin - pairLeftStart
          const maxD = pairRightStart - pairRightMin
          let adjMin = minD
          let adjMax = maxD
          if (pairLeftMax !== undefined) adjMax = Math.min(adjMax, pairLeftMax - pairLeftStart)
          if (pairRightMax !== undefined) adjMin = Math.max(adjMin, pairRightStart - pairRightMax)
          const clamped = Math.min(adjMax, Math.max(adjMin, requestedDelta))
          return { left: pairLeftStart + clamped, right: pairRightStart - clamped, delta: clamped }
        }
        const res = pairedWidths(pairLeftStart, pairRightStart, requestedDelta, pairLeftMin, pairRightMin)
        return res
      })()
      pairedLeft = left
      pairedRight = right
      const nextCollapsed = threshold > 0 && (left < threshold || right < threshold)
      if (nextCollapsed !== collapsed) {
        collapsed = nextCollapsed
        onCollapseChange?.(collapsed)
      }
      if (collapsed) return
      // Transient writes: at most 2 DOM writes, O(1), no Solid render.
      // An absorbing side is skipped -- flexbox gives it exactly the
      // complementary width, which is what conserves the pair sum.
      const writeSide = (el: HTMLElement | null, absorb: boolean, value: number, onResize: (v: number) => void) => {
        if (absorb) return
        if (el) {
          if (isHorizontal) el.style.width = `${value}px`
          else el.style.height = `${value}px`
          return
        }
        // No element ref: fall back to a store write (still rAF-coalesced).
        onResize(value)
      }
      writeSide(cachedLeftEl, pairLeftAbsorb, left, (pair!.left as ResizeHandlePairSide).onResize)
      writeSide(cachedRightEl, pairRightAbsorb, right, pair!.right.onResize)
      if (import.meta.env.DEV) {
        const conserved = Math.abs(pairLeftStart + pairRightStart - (left + right)) < 0.5
        if (!conserved) console.warn("[resize] pair conservation violated", { left, right, sum: left + right, expected: pairLeftStart + pairRightStart, delta })
      }
    }

    const applyActive = (pointerPos: number) => {
      if (isGroup) applyGroupPaired(pointerPos)
      else if (hasPair) applyPaired(pointerPos)
      else applySingle(pointerPos)
    }

    const flush = () => {
      framePending = false
      rafId = null
      applyActive(latestPointer)
    }

    const schedule = () => {
      if (framePending) return
      framePending = true
      rafId = requestAnimationFrame(flush)
    }

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== activePointerId) return
      latestPointer = isHorizontal ? moveEvent.clientX : moveEvent.clientY
      schedule()
    }

    const end = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      framePending = false
      document.body.style.userSelect = ""
      document.body.style.cursor = ""
      target.releasePointerCapture?.(e.pointerId)
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
      window.removeEventListener("pointercancel", onPointerCancel)
      activePointerId = null
      cleanupDrag = null
    }

    const onPointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== activePointerId) return
      // Ensure final position is flushed even if rAF was pending
      latestPointer = isHorizontal ? upEvent.clientX : upEvent.clientY
      if (framePending && rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
        framePending = false
        applyActive(latestPointer)
      } else if (!framePending) {
        // Direct apply if no frame was pending (ensures last delta committed without extra rAF)
        applyActive(latestPointer)
      }
      const wasCollapsed = collapsed
      end()
      if (wasCollapsed) {
        onCollapse?.()
        return
      }
      onCollapseChange?.(false)
      // Commit final geometry to persistent store (single write)
      if (isGroup) {
        // Round once, at commit (§31): re-derive rounded values from the
        // group's last computed state so the persisted geometry matches
        // what was last rendered, with no drift accumulated across drags.
        groupSides!.forEach((side, i) => {
          if (side.absorb) return
          const finalValue = Math.round(groupValues[i])
          const el = groupEls[i]
          if (el) {
            if (isHorizontal) el.style.width = `${finalValue}px`
            else el.style.height = `${finalValue}px`
          }
          side.onResize(finalValue)
        })
        if (!pairRightAbsorb) {
          const finalRight = Math.round(pairedRight)
          if (cachedRightEl) {
            if (isHorizontal) cachedRightEl.style.width = `${finalRight}px`
            else cachedRightEl.style.height = `${finalRight}px`
          }
          pair!.right.onResize(finalRight)
        }
      } else if (hasPair) {
        // If we used transient DOM writes, commit once here; else the per-frame sets already committed,
        // but we re-commit final to ensure rounded persistence
        // Round once, at commit (§31), so the rendered geometry and the
        // persisted geometry agree and no drift accumulates across drags.
        const finalLeft = Math.round(pairedLeft)
        const finalRight = Math.round(pairedRight)
        if (!pairLeftAbsorb) {
          if (cachedLeftEl) {
            if (isHorizontal) cachedLeftEl.style.width = `${finalLeft}px`
            else cachedLeftEl.style.height = `${finalLeft}px`
          }
          ;(pair!.left as ResizeHandlePairSide).onResize(finalLeft)
        }
        if (!pairRightAbsorb) {
          if (cachedRightEl) {
            if (isHorizontal) cachedRightEl.style.width = `${finalRight}px`
            else cachedRightEl.style.height = `${finalRight}px`
          }
          pair!.right.onResize(finalRight)
        }
      } else {
        // Single mode with transient ref: commit
        if (cachedSingleEl) {
          const final = Math.round(clamp(current))
          if (isHorizontal) cachedSingleEl.style.width = `${final}px`
          else cachedSingleEl.style.height = `${final}px`
          local.onResize(final)
        } else {
          // Already committed per-frame; ensure final is clamped/rounded
          // Only commit if not collapsed (already returned)
        }
      }
    }

    const onPointerCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== activePointerId) return
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      framePending = false
      end()
      onCollapseChange?.(false)
      // No commit on cancel: transient styles remain but will be overwritten
      // by next Solid render (which still holds start sizes), so no stale geometry
    }

    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
    window.addEventListener("pointercancel", onPointerCancel)
    cleanupDrag = end
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    // Paired keyboard handling: move divider by step, conserving pair
    if (local.pair) {
      const step = local.keyboardStep ?? DEFAULT_KEYBOARD_STEP
      const isHoriz = local.direction === "horizontal"
      const rtl = isHoriz && getComputedStyle(e.currentTarget as HTMLElement).direction === "rtl"
      const edge = resolveEdge()
      const growKey = isHoriz ? (rtl ? "ArrowLeft" : "ArrowRight") : edge === "end" ? "ArrowDown" : "ArrowUp"
      const shrinkKey = isHoriz ? (rtl ? "ArrowRight" : "ArrowLeft") : edge === "end" ? "ArrowUp" : "ArrowDown"
      let delta = 0
      const isKeyGroup = Array.isArray(local.pair.left)
      const groupTotalMin = isKeyGroup ? (local.pair.left as ResizeHandlePairSide[]).reduce((s, m) => s + m.min, 0) : 0
      const groupTotalSize = isKeyGroup ? (local.pair.left as ResizeHandlePairSide[]).reduce((s, m) => s + m.size, 0) : 0
      if (e.key === growKey) delta = step
      else if (e.key === shrinkKey) delta = -step
      else if (e.key === "Home") delta = isKeyGroup ? groupTotalMin - groupTotalSize : (local.pair.left as ResizeHandlePairSide).min - (local.pair.left as ResizeHandlePairSide).size
      else if (e.key === "End") delta = local.pair.right.size - local.pair.right.min
      else return
      e.preventDefault()
      if (isKeyGroup) {
        const group = local.pair.left as ResizeHandlePairSide[]
        const groupMembers = group.map((m) => ({ size: m.size, min: m.min, max: m.max }))
        const clamped = clampGroupDelta(groupMembers, local.pair.right.min, local.pair.right.max, local.pair.right.size, delta)
        const nextValues = distributeGroupDelta(groupMembers, clamped, local.pair.groupMode)
        group.forEach((m, i) => {
          if (!m.absorb) m.onResize(Math.round(nextValues[i]))
        })
        if (!local.pair.right.absorb) local.pair.right.onResize(Math.round(local.pair.right.size - clamped))
        return
      }
      const { left, right } = pairedWidths(
        (local.pair.left as ResizeHandlePairSide).size,
        local.pair.right.size,
        delta,
        (local.pair.left as ResizeHandlePairSide).min,
        local.pair.right.min,
      )
      if (!(local.pair.left as ResizeHandlePairSide).absorb) (local.pair.left as ResizeHandlePairSide).onResize(Math.round(left))
      if (!local.pair.right.absorb) local.pair.right.onResize(Math.round(right))
      return
    }

    const step = local.keyboardStep ?? DEFAULT_KEYBOARD_STEP
    const edge = resolveEdge()
    const rtl =
      local.direction === "horizontal" && getComputedStyle(e.currentTarget as HTMLElement).direction === "rtl"

    const growKey =
      local.direction === "vertical" ? (edge === "end" ? "ArrowDown" : "ArrowUp") : rtl ? "ArrowLeft" : "ArrowRight"
    const shrinkKey =
      local.direction === "vertical" ? (edge === "end" ? "ArrowUp" : "ArrowDown") : rtl ? "ArrowRight" : "ArrowLeft"

    let delta = 0
    if (e.key === growKey) delta = step
    else if (e.key === shrinkKey) delta = -step
    else if (e.key === "Home") delta = local.min - local.size
    else if (e.key === "End") delta = local.max - local.size
    else return

    e.preventDefault()
    local.onResize(clamp(local.size + delta))
  }

  // If the handle unmounts mid-drag (panel collapses, route changes), make
  // sure the window-level pointer listeners and body style overrides don't
  // outlive the element.
  onCleanup(() => {
    cleanupDrag?.()
  })

  return (
    <div
      {...rest}
      data-component="resize-handle"
      data-direction={local.direction}
      data-edge={local.edge ?? (local.direction === "vertical" ? "start" : "end")}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      role="separator"
      aria-orientation={local.direction === "horizontal" ? "vertical" : "horizontal"}
      aria-valuemin={local.min}
      aria-valuemax={local.max}
      aria-valuenow={local.size}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    />
  )
}
