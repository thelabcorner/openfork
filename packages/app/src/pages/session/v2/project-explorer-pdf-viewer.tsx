import { createEffect, createMemo, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import "./project-explorer-pdf-viewer.css"

const MIN_ZOOM = 0.1
const MAX_ZOOM = 3
const ZOOM_STEP = 1.25
const LOAD_TIMEOUT_MS = 10_000

/**
 * The editor pane passes a data URL (`data:application/pdf;base64,...`);
 * tolerate a bare base64 string as well.
 */
function pdfBytes(content: string) {
  const base64 = content.startsWith("data:") ? content.slice(content.indexOf(",") + 1) : content
  if (!base64) return null
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

export function ProjectExplorerPdfViewer(props: { path: string; content: string }): JSX.Element {
  const language = useLanguage()
  const [viewer, setViewer] = createStore({ zoom: 1, loaded: false, failed: false })

  // Native Chromium PDF rendering via a blob URL; the iframe is attached
  // only once the URL exists and remounts (with a fresh load) on content change.
  const blobUrl = createMemo(() => {
    const bytes = pdfBytes(props.content)
    if (!bytes) return undefined
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))
    onCleanup(() => URL.revokeObjectURL(url))
    return url
  })

  let loadTimer: ReturnType<typeof setTimeout> | undefined
  const clearLoadTimer = () => {
    if (loadTimer !== undefined) clearTimeout(loadTimer)
  }

  createEffect(() => {
    blobUrl()
    clearLoadTimer()
    setViewer({ loaded: false, failed: false })
    loadTimer = setTimeout(() => setViewer("failed", true), LOAD_TIMEOUT_MS)
  })

  onCleanup(clearLoadTimer)

  const failed = () => !blobUrl() || viewer.failed
  const percent = () => language.t("projectExplorer.editor.zoomPercent", { percent: Math.round(viewer.zoom * 100) })
  const zoomIn = () => setViewer("zoom", clampZoom(viewer.zoom * ZOOM_STEP))
  const zoomOut = () => setViewer("zoom", clampZoom(viewer.zoom / ZOOM_STEP))
  const resetZoom = () => setViewer("zoom", 1)

  return (
    <div data-component="project-explorer-pdf-viewer">
      <Show
        when={blobUrl() && !failed()}
        fallback={<div data-slot="project-explorer-pdf-overlay">{language.t("projectExplorer.editor.pdfFailed")}</div>}
      >
        <div data-slot="project-explorer-pdf-scroll">
          {/* CSS zoom changes the iframe's layout viewport, so the native PDF
              viewer re-rasterizes at the zoomed size instead of upscaling a
              base-size bitmap (keeps text crisp; transform: scale does not). */}
          <iframe
            data-slot="project-explorer-pdf-frame"
            title={props.path}
            src={blobUrl()}
            style={{ zoom: viewer.zoom }}
            onLoad={() => {
              clearLoadTimer()
              setViewer("loaded", true)
            }}
            onError={() => setViewer("failed", true)}
          />
        </div>
        <Show when={!viewer.loaded}>
          <div data-slot="project-explorer-pdf-overlay" data-loading>
            <div data-slot="project-explorer-pdf-spinner" />
            {language.t("projectExplorer.editor.pdfLoading")}
          </div>
        </Show>
        <Show when={viewer.loaded}>
          <div data-slot="project-explorer-pdf-toolbar">
            <TooltipV2 value={language.t("projectExplorer.editor.zoomOut")}>
              <IconButtonV2
                type="button"
                size="small"
                variant="ghost-muted"
                aria-label={language.t("projectExplorer.editor.zoomOut")}
                disabled={viewer.zoom <= MIN_ZOOM}
                onClick={zoomOut}
                icon={
                  <span data-slot="project-explorer-pdf-zoom-glyph" aria-hidden="true">
                    −
                  </span>
                }
              />
            </TooltipV2>
            <span data-slot="project-explorer-pdf-zoom-percent">{percent()}</span>
            <TooltipV2 value={language.t("projectExplorer.editor.zoomIn")}>
              <IconButtonV2
                type="button"
                size="small"
                variant="ghost-muted"
                aria-label={language.t("projectExplorer.editor.zoomIn")}
                disabled={viewer.zoom >= MAX_ZOOM}
                onClick={zoomIn}
                icon={
                  <span data-slot="project-explorer-pdf-zoom-glyph" aria-hidden="true">
                    +
                  </span>
                }
              />
            </TooltipV2>
            <TooltipV2 value={language.t("projectExplorer.editor.zoomReset")}>
              <IconButtonV2
                type="button"
                size="small"
                variant="ghost-muted"
                aria-label={language.t("projectExplorer.editor.zoomReset")}
                onClick={resetZoom}
                icon={<Icon name="reset" size="small" />}
              />
            </TooltipV2>
          </div>
        </Show>
      </Show>
    </div>
  )
}
