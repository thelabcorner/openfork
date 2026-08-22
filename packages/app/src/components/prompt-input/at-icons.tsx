import type { JSX } from "solid-js"
import type { SymbolIconGroup } from "./at-row-meta"

// Minimal inline glyphs matching the app icon set's stroke conventions
// (stroke-width 1.5, 16x16 viewBox, currentColor, square linecaps). The
// shared @opencode-ai/ui icon set has no function/class/enum glyphs, so
// these fill that gap for symbol-kind rows in the @mention popover.

const baseSvgProps = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  "stroke-linecap": "square" as const,
  class: "shrink-0",
}

export function SymbolKindIcon(props: { group: SymbolIconGroup; class?: string }): JSX.Element {
  if (props.group === "structural") {
    // Class/interface/type: bracketed block glyph.
    return (
      <svg {...baseSvgProps} class={`shrink-0 ${props.class ?? ""}`}>
        <path d="M5.5 2.5H3.5V13.5H5.5M10.5 2.5H12.5V13.5H10.5" stroke="currentColor" stroke-width="1.3" />
      </svg>
    )
  }
  if (props.group === "value") {
    // Enum/const/variable: filled dot with ring.
    return (
      <svg {...baseSvgProps} class={`shrink-0 ${props.class ?? ""}`}>
        <circle cx="8" cy="8" r="4.5" stroke="currentColor" stroke-width="1.3" />
        <circle cx="8" cy="8" r="1.6" fill="currentColor" />
      </svg>
    )
  }
  // Callable (fn/method): arrow-in-parens glyph.
  return (
    <svg {...baseSvgProps} class={`shrink-0 ${props.class ?? ""}`}>
      <path
        d="M4 3.5L2 8L4 12.5M12 3.5L14 8L12 12.5M6.5 10L9.5 6"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
      />
    </svg>
  )
}

export function ExternalArrowIcon(props: { class?: string }): JSX.Element {
  return (
    <svg {...baseSvgProps} class={`shrink-0 ${props.class ?? ""}`}>
      <path
        d="M6.5 2.5H2.5V13.5H13.5V9.5M9.5 2.5H13.5V6.5M7.5 8.5L13.2 2.8"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="square"
      />
    </svg>
  )
}

export function LockIcon(props: { class?: string }): JSX.Element {
  return (
    <svg {...baseSvgProps} class={`shrink-0 ${props.class ?? ""}`}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="0.5" stroke="currentColor" stroke-width="1.3" />
      <path d="M5.5 7V4.75C5.5 3.23122 6.73122 2 8.25 2C9.76878 2 11 3.23122 11 4.75V7" stroke="currentColor" stroke-width="1.3" />
    </svg>
  )
}

// CSS-only spinner (no JS interval); relies on Tailwind's animate-spin.
export function PendingSpinner(props: { class?: string }): JSX.Element {
  return (
    <svg {...baseSvgProps} class={`shrink-0 animate-spin ${props.class ?? ""}`}>
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3" stroke-opacity="0.25" />
      <path d="M13.5 8C13.5 5.23858 11.2614 3 8.5 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    </svg>
  )
}
