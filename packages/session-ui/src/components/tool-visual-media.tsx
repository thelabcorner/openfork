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
import { createInertialImageZoom } from "@opencode-ai/ui/image-zoom"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import type {
  VisualArtifactPreviewResolver,
  VisualMediaSourceKind,
  VisualToolPresentation,
} from "./tool-visual-media-model"

const MIN_SCALE = 0.25
const MAX_SCALE = 8
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
  if (kind === "read") return t("ui.tool.read")
  if (kind === "baseline") return t("ui.tool.visual.baseline")
  if (kind === "current") return t("ui.tool.visual.current")
  if (kind === "diff") return t("ui.tool.visual.diff")
  if (kind === "frames") return t("ui.tool.visual.frames")
  if (kind === "gif") return t("ui.tool.visual.gif")
  return t("ui.tool.visual.screenshot")
}

function cardLabel(presentation: VisualToolPresentation, t: ReturnType<typeof useI18n>["t"]) {
  if (presentation.kind === "read") return t("ui.tool.read")
  if (presentation.kind === "screenshot") return t("ui.tool.visual.screenshot")
  if (presentation.kind === "capture") return t("ui.tool.visual.capture")
  if (presentation.kind === "diff") return t("ui.tool.visual.diff")
  return t("ui.tool.visual.record")
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
  const [percent, setPercent] = createSignal(100)
  const [targetScale, setTargetScale] = createSignal(1)
  const [expanded, setExpanded] = createSignal(false)
  const [placeholderHeight, setPlaceholderHeight] = createSignal<number>()
  const objectUrls = new Map<string, string>()
  let host: HTMLDivElement | undefined
  let viewport: HTMLDivElement | undefined
  let stage: HTMLDivElement | undefined
  let image: HTMLImageElement | undefined
  let imageZoom: ReturnType<typeof createInertialImageZoom> | undefined
  let loadGeneration = 0
  let stopVisibility: (() => void) | undefined
  let stopResize: (() => void) | undefined

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

  const notifySize = () => {
    if (!props.onContentRendered) return
    requestAnimationFrame(() => props.onContentRendered?.())
  }

  onMount(() => {
    if (!host) return
    stopVisibility = observeNearViewport(host, () => setActive(true))
    if (viewport && stage) {
      imageZoom = createInertialImageZoom({
        viewport,
        stage,
        image: () => image,
        maxScale: MAX_SCALE,
        minScale: MIN_SCALE,
        padding: STAGE_PADDING / 2,
        onScale: (current, target) => {
          const rounded = Math.round(current * 100)
          setPercent((current) => current === rounded ? current : rounded)
          setTargetScale((current) => current === target ? current : target)
        },
      })
      stopResize = observeSize(viewport, ({ width, height }) => imageZoom?.resize(width, height))
      if (image?.complete && image.naturalWidth > 0) imageZoom.setIntrinsic(image.naturalWidth, image.naturalHeight)
    }
  })

  onCleanup(() => {
    stopVisibility?.()
    stopResize?.()
    imageZoom?.dispose()
    loadGeneration += 1
    for (const value of objectUrls.values()) URL.revokeObjectURL(value)
    objectUrls.clear()
  })

  createEffect(() => {
    const current = source()
    if (!current) return
    if (selectedKey() !== current.key) setSelectedKey(current.key)
    const width = props.presentation.width
    const height = props.presentation.height
    if (width && height) imageZoom?.setIntrinsic(width, height)
    else imageZoom?.zoomTo(1, undefined, undefined, false)
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
      setUrl(current.inline.url ?? (current.inline.data ? `data:${current.inline.mime};base64,${current.inline.data}` : undefined))
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

  const reset = () => imageZoom?.reset()

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

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && expanded()) {
      event.preventDefault()
      setExpandedState(false)
      return
    }
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
        data-zoomed={targetScale() !== 1 ? "true" : undefined}
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
              disabled={targetScale() <= MIN_SCALE}
              onClick={() => imageZoom?.zoomBy(-SCALE_STEP)}
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
              {percent()}%
            </button>
            <button
              type="button"
              aria-label={i18n.t("ui.tool.visual.zoomIn")}
              title={i18n.t("ui.tool.visual.zoomIn")}
              disabled={targetScale() >= MAX_SCALE}
              onClick={() => imageZoom?.zoomBy(SCALE_STEP)}
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
          onKeyDown={onKeyDown}
        >
          <div ref={stage} data-slot="tool-visual-stage">
            <Show when={url()}>
              {(src) => (
                <img
                  ref={image}
                  src={src()}
                  alt={i18n.t("ui.tool.visual.previewAlt", { source: sourceName() })}
                  draggable={false}
                  loading="lazy"
                  decoding="async"
                  onLoad={(event) => {
                    const image = event.currentTarget
                    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                      imageZoom?.setIntrinsic(image.naturalWidth, image.naturalHeight)
                    }
                    notifySize()
                  }}
                  onError={() => {
                    setUrl(undefined)
                    setFailed(true)
                    notifySize()
                  }}
                  onClick={() => {
                    if (imageZoom?.consumeDrag()) return
                    if (expanded() || imageZoom?.target() !== 1) return
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

