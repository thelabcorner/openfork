/**
 * Send / Stop concept lab — shared glyphs. DEV-ONLY.
 *
 * Existing composer icons are used wherever one exists (`arrow-up`, `stop`,
 * `arrow-undo-down`, `check` from `@opencode-ai/ui/v2/icon`). Only two marks are
 * new, and both are drawn on the same 16-unit grid and 1px stroke weight as
 * `packages/ui/src/v2/components/icon.tsx` so they sit in the same family.
 */

import { For, type JSX } from "solid-js"

/**
 * Queue / follow-up: the send arrow with a baseline under it. Reads as "send,
 * but behind what is already running" without introducing a second metaphor.
 */
export function LabQueueGlyph(props: { class?: string }) {
  return (
    <svg
      data-slot="icon-svg"
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      class={props.class}
    >
      <path
        fill-rule="evenodd"
        clip-rule="evenodd"
        d="M9.99991 1.74121L16.0921 7.83343L15.2083 8.71731L10.6249 4.13397V14.4001H9.37492V4.13398L4.7916 8.71731L3.90771 7.83343L9.99991 1.74121Z"
        fill="currentColor"
      />
      <path d="M4 17.25H16" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
    </svg>
  )
}

/**
 * Stop, acknowledged: the filled square hollowed out. The silhouette is
 * unchanged, so the transition from Stop to Stopping never re-teaches the mark.
 */
export function LabStoppingGlyph(props: { class?: string }) {
  return (
    <svg
      data-slot="icon-svg"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      class={props.class}
    >
      <rect x="5.25" y="5.25" width="5.5" height="5.5" stroke="currentColor" stroke-width="1.25" />
    </svg>
  )
}

/**
 * Crossfading glyph stack. Both marks stay mounted and share one grid cell, so
 * the swap is a 120ms opacity/scale exchange rather than a mount that can drop a
 * frame at exactly the moment the user is aiming at the control.
 */
export function LabGlyphStack(props: {
  active: () => string
  items: { id: string; node: JSX.Element }[]
  class?: string
}) {
  return (
    <span data-lab-glyph class={props.class}>
      <For each={props.items}>
        {(item) => <span data-lab-glyph-hidden={item.id === props.active() ? "false" : "true"}>{item.node}</span>}
      </For>
    </span>
  )
}
