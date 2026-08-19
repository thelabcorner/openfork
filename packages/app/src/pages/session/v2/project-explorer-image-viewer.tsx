import { createEffect, createMemo, type JSX } from "solid-js"
import { binaryDataUrl } from "./project-explorer-file-kind"
import { createMediaZoom, MediaZoomToolbar } from "./project-explorer-svg-viewer"
import "./project-explorer-media-viewer.css"

/** Image render view on a checkerboard backdrop. `content` is a full data URL
 * (built by the editor pane via binaryDataUrl); a raw-base64 fallback is kept
 * for callers that pass binary content without the data: prefix. The data URL
 * is memoized so zoom (transform-only) never re-renders the img. */
export function ProjectExplorerImageViewer(props: {
  path: string
  content: string
  mime: string
}): JSX.Element {
  const src = createMemo(() =>
    props.content.startsWith("data:") ? props.content : binaryDataUrl(props.content, props.mime),
  )
  let viewport: HTMLDivElement | undefined
  let stage: HTMLDivElement | undefined
  const zoom = createMediaZoom({ viewport: () => viewport, stage: () => stage })

  createEffect(() => {
    props.content
    zoom.reset()
  })

  return (
    <div
      ref={(element) => {
        viewport = element
      }}
      data-component="project-explorer-image-viewer"
      data-path={props.path}
    >
      <div
        ref={(element) => {
          stage = element
        }}
        data-slot="project-explorer-media-stage"
      >
        <img src={src()} alt="" draggable={false} />
      </div>
      <MediaZoomToolbar zoom={zoom} />
    </div>
  )
}
