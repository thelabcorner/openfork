import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { createSignal, onCleanup, onMount } from "solid-js"
import { useI18n } from "../context/i18n"
import { Icon } from "./icon"
import { IconButton } from "./icon-button"
import { createInertialImageZoom } from "./image-zoom"

export type ImagePreviewProps = { alt?: string } & (
  | { src: string; svg?: never }
  | { src?: never; svg: string }
)

export function ImagePreview(props: ImagePreviewProps) {
  const i18n = useI18n()
  let viewport: HTMLDivElement | undefined
  let stage: HTMLDivElement | undefined
  let image: HTMLImageElement | undefined
  let zoom: ReturnType<typeof createInertialImageZoom> | undefined
  let observer: ResizeObserver | undefined
  let sourceBlobUrl: string | undefined
  const [src, setSrc] = createSignal(props.src ?? "")
  const [percent, setPercent] = createSignal(100)
  const [target, setTarget] = createSignal(1)

  const onLoad = () => {
    if (!image || !zoom) return
    zoom.setIntrinsic(image.naturalWidth, image.naturalHeight)
  }

  onMount(() => {
    if (props.svg) {
      sourceBlobUrl = URL.createObjectURL(new Blob([props.svg], { type: "image/svg+xml;charset=utf-8" }))
      setSrc(sourceBlobUrl)
    }
    if (!viewport || !stage) return
    zoom = createInertialImageZoom({
      viewport,
      stage,
      image: () => image,
      padding: 24,
      maxScale: 8,
      onScale: (value, next) => {
        const rounded = Math.round(value * 100)
        if (rounded !== percent()) setPercent(rounded)
        if (next !== target()) setTarget(next)
      },
    })
    if (image?.complete) onLoad()
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect
        if (rect) zoom?.resize(rect.width, rect.height)
      })
      observer.observe(viewport)
    }
    viewport.focus({ preventScroll: true })
  })
  onCleanup(() => {
    observer?.disconnect()
    zoom?.dispose()
    if (sourceBlobUrl) URL.revokeObjectURL(sourceBlobUrl)
  })

  return (
    <div data-component="image-preview">
      <div data-slot="image-preview-container">
        <Kobalte.Content data-slot="image-preview-content">
          <div data-slot="image-preview-header">
            <div data-slot="image-preview-zoom">
              <button type="button" disabled={target() <= 0.25}
                title={i18n.t("ui.tool.visual.zoomOut")} aria-label={i18n.t("ui.tool.visual.zoomOut")}
                onClick={() => zoom?.zoomBy(-0.25)}>
                <Icon name="dash" size="small" />
              </button>
              <button type="button" data-action="reset" title={i18n.t("ui.tool.visual.zoomReset")}
                aria-label={i18n.t("ui.tool.visual.zoomReset")} onClick={() => zoom?.reset()}>
                {percent()}%
              </button>
              <button type="button" disabled={target() >= 8}
                title={i18n.t("ui.tool.visual.zoomIn")} aria-label={i18n.t("ui.tool.visual.zoomIn")}
                onClick={() => zoom?.zoomBy(0.25)}>
                <Icon name="plus-small" size="small" />
              </button>
            </div>
            <Kobalte.CloseButton
              data-slot="image-preview-close"
              as={IconButton}
              icon="close"
              variant="ghost"
              aria-label={i18n.t("ui.common.close")}
            />
          </div>
          <div ref={viewport} data-slot="image-preview-body" tabIndex={0}
            aria-label={props.alt ?? i18n.t("ui.imagePreview.alt")}>
            <div ref={stage} data-slot="image-preview-stage">
              <img ref={image} src={src() || undefined} alt={props.alt ?? i18n.t("ui.imagePreview.alt")}
                data-slot="image-preview-image" draggable={false} decoding="async" onLoad={onLoad} />
            </div>
          </div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
