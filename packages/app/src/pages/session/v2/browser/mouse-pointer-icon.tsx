// Inline lucide `MousePointer2` (classic arrow) as a dependency-free SVG so
// the agent cursor can render without pulling a full icon library into the
// renderer. Stroke uses `currentColor`; the caller styles fill + color with
// v2 tokens (T3: `fill-background text-primary`).

import type { JSX } from "solid-js"

export function MousePointer2Icon(props: { class?: string; strokeWidth?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={props.strokeWidth ?? 2}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={props.class}
    >
      <path d="m4 4 7.07 17 2.51-7.39L21 11.07z" />
    </svg>
  )
}
