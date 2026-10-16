# Chat media zoom: native-source fidelity and inertial interaction

## Product contract

Image and SVG previews across OpenFork chat share one presentation-only image zoom owner:
`packages/ui/src/components/image-zoom.tsx`. It owns the zoom state, critical damping,
viewport-relative cursor anchor, scroll geometry, RAF admission, pointer capture and disposal.
It has no runtime, storage, network, Session or tool-authorization dependencies.

The established Mermaid smoothing constant is 110 ms. Mermaid now imports the
same spring equation instead of maintaining an independent copy. This preserves the
Mermaid behavior without recoding SVG sanitization, rendering or export logic.

## Covered surfaces

| Surface | Entry point | Interaction |
| --- | --- | --- |
| Tool screenshots and visual diffs | `packages/session-ui/src/components/tool-visual-media.tsx` | Zoom inside the existing card/expanded viewer |
| Markdown image/SVG nodes, including inline sanitized SVG and tool output Markdown | `packages/session-ui/src/components/markdown.tsx` | Delegated click/keyboard opens the shared viewer |
| User message attachments and prompt attachments | `ImagePreview` from existing attachment handlers | Shared inertial viewer |
| File/diff panel images and SVGs | `packages/session-ui/src/components/file-media.tsx` | Accessible click/keyboard opens the shared viewer |
| Shared lightbox | `packages/ui/src/components/image-preview.tsx` | Zoom/pan/keyboard and reset |
| Mermaid | `packages/session-ui/src/components/markdown-mermaid.ts` | Existing controls, imported spring |

## Fidelity boundary

- **SVG**: do not turn source SVG into a fixed-size PNG or HTML canvas and zoom
  the raster result. Resize the actual SVG-backed `<img>` render target at each
  animation step. Browser SVG rendering paints vector shapes at the final display
  dimensions, including device-pixel ratio.
- Sanitized Markdown inline SVGs are serialized into a temporary inert SVG Blob
  URL, retaining paint styles computed from the current theme for up to 2,048
  descendants. The Blob URL is revoked when the lightbox closes.
- **Raster**: preserve the original loaded resource/Blob and its intrinsic
  width/height. Do not generate a lossy thumbnail, draw into a lower-resolution
  offscreen canvas, or reuse a previous viewport bitmap as the new source.
  Initial presentation never enlarges tiny rasters beyond intrinsic size.
- At magnifications exceeding source pixels per physical display pixel, raster
  images cannot be truly detail-preserving. Bilinear/bicubic interpolation
  cannot reconstruct unknown details; learned super-resolution would be a
  separate, explicitly labeled *estimated* rendition, never a silent
  substitute for fidelity.
- SVGs can embed raster imagery or filters. Those subresources may retain their
  own resolution limits. Browser maximum texture dimensions and memory are
  still physical limits; huge SVGs need separate visibility-aware tiling or a
  renderer-specific guard before claiming unlimited scaling.

## Interaction contract

- Ctrl/Cmd+wheel zooms around the pointer; wheel without the modifier preserves
  ordinary chat/viewport scroll.
- Button and keyboard zoom use the viewport center.
- Pinch zoom is available in the full-screen preview and expanded tool media.
  Collapsed tool cards preserve ordinary touch page scrolling at fit.
- Critical damping uses a time-aware, target-retargetable RAF loop, coalescing
  multiple input events to a single animation at a time.
- The fixed normalized source anchor defines scroll offsets as the image
  dimensions change; browser scroll clamping bounds panning.
- Reflow stays isolated to the media stage/viewport. No Markdown reparse,
  provider fetch, timeline subscription, or session-history scan occurs per frame.
- Offscreen tool cards retain existing near-viewport lazy artifact loading and
  shared ResizeObserver. The lightbox owns one ResizeObserver only while open.
- All animation frames, capture listeners and observers are disposed when their
  owning viewer is unmounted.
- Reduced-motion preference finishes zoom immediately.

## Verification gates

Run from the existing checkout without restarting an app/backend:

```sh
bun --cwd packages/ui run typecheck
bun --cwd packages/session-ui run typecheck
bun --cwd packages/ui test src/components/image-zoom.test.ts
bun --cwd packages/session-ui test src/components/markdown-mermaid.test.ts src/components/tool-visual-media-model.test.ts
```

The unit test asserts mathematical fit/anchoring, DOM dimensions without
`transform: scale()`, modifier wheel admission, target clamping and spring
convergence at 30/60/120/240 Hz. This does not constitute end-to-end screenshot
evidence. Visual verification in an existing desktop app session should cover
complex SVG curves/text at 400%, a 4K bitmap at native resolution, clipping,
source switching during a pending spring, dark/light checkerboard, nested
Markdown image links, and active multi-Session timelines.

## Out of scope

Existing project-explorer image/SVG editor-viewers are distinct product
surfaces and retain their current media zoom implementation. Their stage
transform pipeline should be audited separately for vector re-rasterization
under GPU layer promotion; avoid claiming they use this chat viewer.
