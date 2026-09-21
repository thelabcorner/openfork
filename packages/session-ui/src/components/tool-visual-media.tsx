import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import type {
  VisualArtifactPreviewResolver,
  VisualMediaSourceKind,
  VisualToolPresentation,
} from "./tool-visual-media-model"

const MIN_SCALE = 0.25
const MAX_SCALE = 6
const SCALE_STEP = 0.25
const STAGE_PADDING = 36

type NearViewportCallback = () => void
let nearViewportObserver: IntersectionObserver | undefined
const nearViewportCallbacks = new Map<Element, NearViewportCallback>()

type ResizeCallback = (size: { width: number; height: number }) => void
let sharedResizeObserver: ResizeObserver | undefined
const resizeCallbacks = new Map<Element, ResizeCallback>()

function observeNearViewport(element: Element, callback: NearViewportCallback) {
  if (typeof IntersectionObserver === "undefined") {
    callback()
    return () => {}
  }
  if (!nearViewportObserver) {
    nearViewportObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const next = nearViewportCallbacks.get(entry.target)
          if (!next) continue
          nearViewportCallbacks.delete(entry.target)
          nearViewportObserver?.unobserve(entry.target)
          next()
        }
      },
      { rootMargin: "600px 0px" },
    )
  }
  nearViewportCallbacks.set(element, callback)
  nearViewportObserver.observe(element)
  return () => {
    nearViewportCallbacks.delete(element)
    nearViewportObserver?.unobserve(element)
    if (nearViewportCallbacks.size) return
    nearViewportObserver?.disconnect()
    nearViewportObserver = undefined
  }
}

function observeSize(element: HTMLElement, callback: ResizeCallback) {
  const measure = () => {
    const rect = element.getBoundingClientRect()
    callback({ width: rect.width, height: rect.height })
  }
  if (typeof ResizeObserver === "undefined") {
    measure()
    return () => {}
  }
  if (!sharedResizeObserver) {
    sharedResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const next = resizeCallbacks.get(entry.target)
        if (!next) continue
        next({ width: entry.contentRect.width, height: entry.contentRect.height })
      }
    })
  }
  resizeCallbacks.set(element, callback)
  sharedResizeObserver.observe(element)
  measure()
  return () => {
    resizeCallbacks.delete(element)
    sharedResizeObserver?.unobserve(element)
    if (resizeCallbacks.size) return
    sharedResizeObserver?.disconnect()
    sharedResizeObserver = undefined
  }
}

function sourceLabel(kind: VisualMediaSourceKind, t: ReturnType<typeof useI18n>["t"]) {
  if (kind === "baseline") return t("ui.tool.visual.baseline")
  if (kind === "current") return t("ui.tool.visual.current")
  if (kind === "diff") return t("ui.tool.visual.diff")
  if (kind === "frames") return t("ui.tool.visual.frames")
  if (kind === "gif") return t("ui.tool.visual.gif")
  return t("ui.tool.visual.screenshot")
}

function cardLabel(presentation: VisualToolPresentation, t: ReturnType<typeof useI18n>["t"]) {
  if (presentation.kind === "screenshot") return t("ui.tool.visual.screenshot")
  if (presentation.kind === "capture") return t("ui.tool.visual.capture")
  if (presentation.kind === "diff") return t("ui.tool.visual.diff")
  return t("ui.tool.visual.record")
}

function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

export function ToolVisualMedia(props: {
  presentation: VisualToolPresentation
  resolveArtifact?: VisualArtifactPreviewResolver
  onContentRendered?: () => void
}) {
  const i18n = useI18n()
  const [selectedKey, setSelectedKey] = createSignal(props.presentation.initialSource)
  const [active, setActive] = createSignal(false)
  const [url, setUrl] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const [scale, setScale] = createSignal(1)
  const [expanded, setExpanded] = createSignal(false)
  const [placeholderHeight, setPlaceholderHeight] = createSignal<number>()
  const [intrinsicSize, setIntrinsicSize] = createSignal<{ width: number; height: number }>()
  const [viewportSize, setViewportSize] = createSignal({ width: 0, height: 0 })
  const objectUrls = new Map<string, string>()
  let host: HTMLDivElement | undefined
  let viewport: HTMLDivElement | undefined
  let loadGeneration = 0
  let stopVisibility: (() => void) | undefined
  let stopResize: (() => void) | undefined
  let pointer: { id: number; x: number; y: number; left: number; top: number; moved: boolean } | undefined
  let dragged = false

  const source = createMemo(
    () => props.presentation.sources.find((candidate) => candidate.key === selectedKey()) ?? props.presentation.sources[0],
  )
  const sourceName = createMemo(() => sourceLabel(source()?.kind ?? "screenshot", i18n.t))
  const identity = createMemo(() => cardLabel(props.presentation, i18n.t))
  const meta = createMemo(() => {
    const bits: string[] = []
    if (props.presentation.name) bits.push(props.presentation.name)
    if (props.presentation.diff) {
      bits.push(
        props.presentation.diff.changed
          ? i18n.t("ui.tool.visual.changed")
          : i18n.t("ui.tool.visual.unchanged"),
      )
      if (props.presentation.diff.changedRatio !== undefined) {
        bits.push(`${(props.presentation.diff.changedRatio * 100).toFixed(4)}%`)
      }
      if (props.presentation.diff.regionCount !== undefined) {
        bits.push(i18n.plural("ui.tool.visual.regions", props.presentation.diff.regionCount))
      }
    }
    if (props.presentation.width && props.presentation.height) bits.push(`${props.presentation.width}×${props.presentation.height}`)
    if (props.presentation.captureMs !== undefined) bits.push(`${Math.round(props.presentation.captureMs)} ms`)
    return bits.join(" · ")
  })
  const baseSize = createMemo(() => {
    const image = intrinsicSize()
    const view = viewportSize()
    if (!image || image.width <= 0 || image.height <= 0 || view.width <= 0 || view.height <= 0) return
    const availableWidth = Math.max(1, view.width - STAGE_PADDING)
    const availableHeight = Math.max(1, view.height - STAGE_PADDING)
    const fit = Math.min(1, availableWidth / image.width, availableHeight / image.height)
    return { width: image.width * fit, height: image.height * fit }
  })
  const scaledSize = createMemo(() => {
    const base = baseSize()
    if (!base) return
    return { width: base.width * scale(), height: base.height * scale() }
  })
  const stageStyle = createMemo(() => {
    const image = scaledSize()
    const view = viewportSize()
    if (!image || view.width <= 0 || view.height <= 0) return undefined
    return {
      width: `${Math.max(view.width, image.width + STAGE_PADDING)}px`,
      height: `${Math.max(view.height, image.height + STAGE_PADDING)}px`,
    }
  })

  const notifySize = () => {
    if (!props.onContentRendered) return
    requestAnimationFrame(() => props.onContentRendered?.())
  }

  onMount(() => {
    if (!host) return
    stopVisibility = observeNearViewport(host, () => setActive(true))
    if (viewport) stopResize = observeSize(viewport, setViewportSize)
  })

  onCleanup(() => {
    stopVisibility?.()
    stopResize?.()
    loadGeneration += 1
    for (const value of objectUrls.values()) URL.revokeObjectURL(value)
    objectUrls.clear()
  })

  createEffect(() => {
    const current = source()
    if (!current) return
    if (selectedKey() !== current.key) setSelectedKey(current.key)
    setScale(1)
    const width = props.presentation.width
    const height = props.presentation.height
    setIntrinsicSize(width && height ? { width, height } : undefined)
    if (!active()) return

    const generation = ++loadGeneration
    setFailed(false)
    const cached = objectUrls.get(current.key)
    if (cached) {
      setLoading(false)
      setUrl(cached)
      notifySize()
      return
    }

    if (current.inline) {
      setLoading(false)
      setUrl(`data:${current.inline.mime};base64,${current.inline.data}`)
      notifySize()
      return
    }

    if (!current.artifact || !props.resolveArtifact) {
      setLoading(false)
      setUrl(undefined)
      setFailed(true)
      notifySize()
      return
    }

    setLoading(true)
    setUrl(undefined)
    void props.resolveArtifact(current.artifact).then(
      (preview) => {
        if (generation !== loadGeneration) return
        if (!preview || !preview.descriptor.mime.startsWith("image/")) {
          setLoading(false)
          setFailed(true)
          notifySize()
          return
        }
        const bytes = new Uint8Array(preview.bytes)
        const next = URL.createObjectURL(new Blob([bytes.buffer], { type: preview.descriptor.mime }))
        objectUrls.set(current.key, next)
        setUrl(next)
        setLoading(false)
        notifySize()
      },
      () => {
        if (generation !== loadGeneration) return
        setLoading(false)
        setFailed(true)
        notifySize()
      },
    )
  })

  const zoom = (next: number, clientX?: number, clientY?: number) => {
    const element = viewport
    const target = clampScale(next)
    if (!element || target === scale()) {
      setScale(target)
      return
    }
    const rect = element.getBoundingClientRect()
    const localX = clientX === undefined ? rect.width / 2 : clientX - rect.left
    const localY = clientY === undefined ? rect.height / 2 : clientY - rect.top
    const anchorX = element.scrollLeft + localX
    const anchorY = element.scrollTop + localY
    const ratio = target / scale()
    setScale(target)
    requestAnimationFrame(() => {
      if (!viewport) return
      viewport.scrollLeft = anchorX * ratio - localX
      viewport.scrollTop = anchorY * ratio - localY
    })
  }

  const reset = () => {
    setScale(1)
    requestAnimationFrame(() => {
      viewport?.scrollTo({ left: 0, top: 0, behavior: "smooth" })
    })
  }

  const setExpandedState = (next: boolean) => {
    if (next === expanded()) return
    if (next && host) {
      const height = host.getBoundingClientRect().height
      if (height > 0) setPlaceholderHeight(height)
    }
    setExpanded(next)
    requestAnimationFrame(() => {
      if (!next) {
        reset()
        setPlaceholderHeight(undefined)
      }
      viewport?.focus({ preventScroll: true })
      props.onContentRendered?.()
    })
  }

  const onTabsKeyDown = (event: KeyboardEvent) => {
    if (!(event.currentTarget instanceof HTMLElement)) return
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]'))
    const current = tabs.indexOf(event.target as HTMLButtonElement)
    if (current < 0) return
    let next = current
    if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length
    else if (event.key === "ArrowRight") next = (current + 1) % tabs.length
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = tabs.length - 1
    else return
    event.preventDefault()
    const tab = tabs[next]
    const key = tab?.dataset.sourceKey
    if (!tab || !key) return
    setSelectedKey(key)
    tab.focus()
  }

  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    const pixels =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * (viewport?.clientHeight ?? 600)
          : event.deltaY
    const bounded = Math.max(-180, Math.min(180, pixels))
    zoom(scale() * Math.exp(-bounded * 0.0018), event.clientX, event.clientY)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && expanded()) {
      event.preventDefault()
      setExpandedState(false)
      return
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault()
      zoom(scale() + SCALE_STEP)
      return
    }
    if (event.key === "-") {
      event.preventDefault()
      zoom(scale() - SCALE_STEP)
      return
    }
    if (event.key === "0") {
      event.preventDefault()
      reset()
      return
    }
    if (!viewport) return
    const amount = event.shiftKey ? 48 : 20
    const delta =
      event.key === "ArrowLeft" ? { left: -amount, top: 0 }
      : event.key === "ArrowRight" ? { left: amount, top: 0 }
      : event.key === "ArrowUp" ? { left: 0, top: -amount }
      : event.key === "ArrowDown" ? { left: 0, top: amount }
      : undefined
    if (!delta) return
    event.preventDefault()
    viewport.scrollBy({ ...delta, behavior: "smooth" })
  }

  const stopPan = (event: PointerEvent) => {
    if (!pointer || pointer.id !== event.pointerId) return
    pointer = undefined
    if (viewport) delete viewport.dataset.panning
  }

  return (
    <div
      data-component="tool-visual-media-shell"
      data-expanded={expanded() ? "true" : undefined}
      style={{ height: expanded() && placeholderHeight() ? `${placeholderHeight()}px` : undefined }}
    >
      <div
        ref={host}
        data-component="tool-visual-media"
        data-origin={props.presentation.origin}
        data-expanded={expanded() ? "true" : undefined}
        data-zoomed={scale() !== 1 ? "true" : undefined}
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.key !== "Escape" || !expanded()) return
          event.preventDefault()
          setExpandedState(false)
        }}
      >
        <div data-slot="tool-visual-header">
          <div data-slot="tool-visual-identity">
            <Icon name={props.presentation.kind === "diff" ? "review" : "photo"} size="small" />
            <span data-slot="tool-visual-label">{identity()}</span>
            <Show when={meta()}>
              <span data-slot="tool-visual-meta">{meta()}</span>
            </Show>
          </div>
          <Show when={props.presentation.sources.length > 1}>
            <div data-slot="tool-visual-tabs" role="tablist" onKeyDown={onTabsKeyDown}>
              <For each={props.presentation.sources}>
                {(entry) => (
                  <button
                    type="button"
                    role="tab"
                    tabIndex={entry.key === selectedKey() ? 0 : -1}
                    aria-selected={entry.key === selectedKey()}
                    data-source-key={entry.key}
                    data-active={entry.key === selectedKey() ? "true" : undefined}
                    onClick={() => setSelectedKey(entry.key)}
                  >
                    {sourceLabel(entry.kind, i18n.t)}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <div data-slot="tool-visual-actions">
            <button
              type="button"
              aria-label={i18n.t("ui.tool.visual.zoomOut")}
              title={i18n.t("ui.tool.visual.zoomOut")}
              disabled={scale() <= MIN_SCALE}
              onClick={() => zoom(scale() - SCALE_STEP)}
            >
              <Icon name="dash" size="small" />
            </button>
            <button
              type="button"
              data-action="scale"
              aria-label={i18n.t("ui.tool.visual.zoomReset")}
              title={i18n.t("ui.tool.visual.zoomReset")}
              onClick={reset}
            >
              {Math.round(scale() * 100)}%
            </button>
            <button
              type="button"
              aria-label={i18n.t("ui.tool.visual.zoomIn")}
              title={i18n.t("ui.tool.visual.zoomIn")}
              disabled={scale() >= MAX_SCALE}
              onClick={() => zoom(scale() + SCALE_STEP)}
            >
              <Icon name="plus-small" size="small" />
            </button>
            <button
              type="button"
              aria-label={expanded() ? i18n.t("ui.tool.visual.collapse") : i18n.t("ui.tool.visual.expand")}
              title={expanded() ? i18n.t("ui.tool.visual.collapse") : i18n.t("ui.tool.visual.expand")}
              data-active={expanded() ? "true" : undefined}
              onClick={() => setExpandedState(!expanded())}
            >
              <Icon name={expanded() ? "collapse" : "expand"} size="small" />
            </button>
          </div>
        </div>

        <div
          ref={viewport}
          data-slot="tool-visual-viewport"
          data-panning={undefined}
          tabIndex={0}
          aria-label={i18n.t("ui.tool.visual.viewport", { source: sourceName() })}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
          onDblClick={reset}
          onPointerDown={(event) => {
            if (event.button !== 0 || !viewport) return
            if (viewport.scrollWidth <= viewport.clientWidth && viewport.scrollHeight <= viewport.clientHeight) return
            event.preventDefault()
            dragged = false
            pointer = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              left: viewport.scrollLeft,
              top: viewport.scrollTop,
              moved: false,
            }
            viewport.setPointerCapture(event.pointerId)
            viewport.dataset.panning = "true"
          }}
          onPointerMove={(event) => {
            if (!pointer || pointer.id !== event.pointerId || !viewport) return
            const dx = event.clientX - pointer.x
            const dy = event.clientY - pointer.y
            if (Math.abs(dx) + Math.abs(dy) > 3) {
              pointer.moved = true
              dragged = true
            }
            viewport.scrollLeft = pointer.left - dx
            viewport.scrollTop = pointer.top - dy
          }}
          onPointerUp={stopPan}
          onPointerCancel={stopPan}
        >
          <div data-slot="tool-visual-stage" style={stageStyle()}>
            <Show when={url()}>
              {(src) => (
                <img
                  src={src()}
                  alt={i18n.t("ui.tool.visual.previewAlt", { source: sourceName() })}
                  draggable={false}
                  loading="lazy"
                  decoding="async"
                  style={{
                    width: scaledSize() ? `${scaledSize()!.width}px` : `${scale() * 100}%`,
                    height: scaledSize() ? `${scaledSize()!.height}px` : "auto",
                  }}
                  onLoad={(event) => {
                    const image = event.currentTarget
                    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                      setIntrinsicSize({ width: image.naturalWidth, height: image.naturalHeight })
                    }
                    notifySize()
                  }}
                  onClick={() => {
                    if (dragged) {
                      dragged = false
                      return
                    }
                    if (expanded() || scale() !== 1) return
                    setExpandedState(true)
                  }}
                />
              )}
            </Show>
            <Show when={!url() && loading()}>
              <div data-slot="tool-visual-status">
                <span data-slot="tool-visual-spinner" aria-hidden="true" />
                <span>{i18n.t("ui.tool.visual.loading")}</span>
              </div>
            </Show>
            <Show when={!url() && !loading() && failed()}>
              <div data-slot="tool-visual-status" data-error="true">
                <Icon name="warning" size="small" />
                <span>{i18n.t("ui.tool.visual.unavailable")}</span>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}

