import { createEffect, createMemo, createSignal, onCleanup, onMount, For, Index, Show } from "solid-js"
import type { Accessor } from "solid-js"

type Props<T> = {
  items: T[]
  // fixed height or per-item function — used as the initial guess; if `getKey`
  // is provided, real measured heights (via ResizeObserver) override the guess
  // once a row has been rendered at least once.
  estimateSize: number | ((item: T, index: number) => number)
  overscan?: number
  // scroll container — if not provided, uses the parent with .view-scroll
  scrollRef?: () => HTMLElement | undefined
  renderItem: (item: T, index: number) => import("solid-js").JSX.Element
  renderItemAccessor?: (item: Accessor<T>, index: number) => import("solid-js").JSX.Element
  // Stable per-item identity (e.g. message id). Enabling this turns on real
  // height measurement + scroll-anchoring, which matters for content with
  // highly variable, hard-to-estimate heights (markdown, tool calls, code).
  getKey?: (item: T, index: number) => string
}

// Lightweight windowing for 1k+ rows. No external dep, no DOM recycling — just slices.
// Fixed-size fast path; variable-height via per-item estimate + binary search on
// cumulative offsets, corrected by real measurements when `getKey` is set.
// Optimized for mobile: rAF-throttled scroll, ResizeObserver.
export function VirtualList<T>(props: Props<T>) {
  const overscan = () => props.overscan ?? 6
  const getEstimate = (item: T, i: number) =>
    typeof props.estimateSize === "function" ? (props.estimateSize as (it: T, idx: number) => number)(item, i) : (props.estimateSize as number)

  // measured[key] = real rendered height, once known. Falls back to the estimate.
  const [measured, setMeasured] = createSignal<Map<string, number>>(new Map(), { equals: false })
  const getSize = (item: T, i: number) => {
    if (!props.getKey) return getEstimate(item, i)
    const m = measured().get(props.getKey(item, i))
    return m ?? getEstimate(item, i)
  }

  const [scrollTop, setScrollTop] = createSignal(0)
  const [viewportH, setViewportH] = createSignal(400)

  let scrollEl: HTMLElement | undefined

  const resolveScrollEl = () => props.scrollRef?.() ?? scrollEl?.parentElement as HTMLElement | undefined

  // cumulative offsets for variable heights — recomputed when items or measurements change
  const offsets = createMemo(() => {
    const o: number[] = [0]
    for (let i = 0; i < props.items.length; i++) o.push(o[i]! + getSize(props.items[i]!, i))
    return o
  })
  const totalH = createMemo(() => offsets()[props.items.length] ?? 0)

  const findStart = (top: number, off: number[]) => {
    // binary search largest idx where off[idx] <= top
    let lo = 0, hi = off.length - 1
    while (lo < hi) {
      const mid = ((lo + hi + 1) >> 1)
      if (off[mid]! <= top) lo = mid
      else hi = mid - 1
    }
    return Math.min(lo, props.items.length - 1)
  }

  const range = createMemo(() => {
    const top = scrollTop()
    const h = viewportH()
    const off = offsets()
    if (props.items.length === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 }
    if (typeof props.estimateSize === "number" && !props.getKey) {
      const size = props.estimateSize as number
      const start = Math.max(0, Math.floor(top / size) - overscan())
      const end = Math.min(props.items.length, Math.ceil((top + h) / size) + overscan())
      return { start, end, padTop: start * size, padBottom: (props.items.length - end) * size }
    }
    const rawStart = findStart(top, off)
    const start = Math.max(0, rawStart - overscan())
    // find end by scanning forward until offset exceeds top+h
    let end = start
    const limit = top + h + overscan() * 36 // ~overscan rows worth
    while (end < props.items.length && off[end]! < limit) end++
    end = Math.min(props.items.length, end + overscan())
    const padTop = off[start] ?? 0
    const padBottom = totalH() - (off[end] ?? totalH())
    return { start, end, padTop, padBottom }
  })

  const visible = createMemo(() => {
    const r = range()
    return props.items.slice(r.start, r.end)
  })

  let raf = 0
  const onScroll = () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      const el = resolveScrollEl()
      if (el) setScrollTop(el.scrollTop)
    })
  }

  onMount(() => {
    const el = resolveScrollEl()
    if (!el) return
    // initial viewport
    setViewportH(el.clientHeight)
    setScrollTop(el.scrollTop)
    el.addEventListener("scroll", onScroll, { passive: true })
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight))
    ro.observe(el)
    onCleanup(() => {
      el.removeEventListener("scroll", onScroll)
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    })
  })

  // when items change (filter/search), reset scroll if we were near top? keep position
  createEffect(() => {
    // touch items to re-run offsets/range
    props.items.length
    // if filter shrinks and scrollTop is now beyond totalH, clamp
    const el = resolveScrollEl()
    if (el && el.scrollTop + viewportH() > totalH()) {
      // don't jump — just let range recompute; browser will clamp scrollTop on next frame
    }
  })

  // For tiny lists (< 80) skip windowing entirely — just render all, no spacer math.
  // This keeps the common 7-session case at zero overhead and preserves native
  // scroll behavior for small data sets. When measuring is on (chat messages),
  // still skip windowing below the threshold but keep measuring so growth
  // (streaming) doesn't need a mode switch mid-session.
  const useWindow = createMemo(() => props.items.length > 80)

  // Real-height measurement: each rendered row is wrapped so we can observe its
  // rendered height and correct the estimate. When a row *above* the viewport's
  // current top changes height (streaming growth, late image load, etc.), we
  // shift scrollTop by the delta in the same frame so the visible content
  // doesn't visually jump — the same anchoring trick virtualizers like
  // tanstack-virtual use.
  function measureRow(el: HTMLElement, key: string, index: number) {
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.borderBoxSize?.[0]?.blockSize ?? entries[0]?.contentRect.height
      if (h === undefined) return
      const prev = measured().get(key)
      if (prev !== undefined && Math.abs(prev - h) < 0.5) return
      const scrollEl2 = resolveScrollEl()
      const isAboveViewport = scrollEl2 !== undefined && index < range().start
      const delta = isAboveViewport && prev !== undefined ? h - prev : 0
      setMeasured((m) => {
        const next = new Map(m)
        next.set(key, h)
        return next
      })
      if (delta !== 0 && scrollEl2) scrollEl2.scrollTop += delta
    })
    ro.observe(el)
    onCleanup(() => ro.disconnect())
  }

  return (
    <>
      {/* scroll anchor — the parent .view-scroll is the actual scroller; this component
          just provides a measured container. We render spacers + visible slice. */}
      <div ref={(el) => (scrollEl = el)} style={{ position: "absolute", inset: "0", "pointer-events": "none", height: "0" }} aria-hidden="true" />
      <Show
        when={useWindow()}
        fallback={
          props.renderItemAccessor ? (
            <Index each={props.items}>
              {(it, i) =>
                props.getKey ? (
                  <div ref={(el) => measureRow(el, props.getKey!(it(), i), i)}>{props.renderItemAccessor!(it, i)}</div>
                ) : (
                  props.renderItemAccessor!(it, i)
                )
              }
            </Index>
          ) : (
            <For each={props.items}>
              {(it, i) =>
                props.getKey ? (
                  <div ref={(el) => measureRow(el, props.getKey!(it, i()), i())}>{props.renderItem(it, i())}</div>
                ) : (
                  props.renderItem(it, i())
                )
              }
            </For>
          )
        }
      >
        <div style={{ height: `${range().padTop}px`, "flex-shrink": "0" }} />
        <For each={visible()}>
          {(it, idx) => {
            // idx is within visible slice; map back to absolute index for renderItem
            const abs = () => range().start + (idx() as number)
            if (!props.getKey) return props.renderItem(it, abs())
            return <div ref={(el) => measureRow(el, props.getKey!(it, abs()), abs())}>{props.renderItem(it, abs())}</div>
          }}
        </For>
        <div style={{ height: `${range().padBottom}px`, "flex-shrink": "0" }} />
        {/* ensure total height is correct for scrollbar — hidden sizer if needed */}
        <Show when={range().padTop + range().padBottom === 0 && totalH() > 0}>
          <div style={{ height: "0" }} />
        </Show>
      </Show>
    </>
  )
}
