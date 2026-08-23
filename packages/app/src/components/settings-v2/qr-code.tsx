import { encode } from "uqr"
import { For, Show, createMemo, type Component } from "solid-js"

// Renders a scannable QR as crisp SVG rects. The matrix is always
// dark-modules-on-light (literal black/white): scanners handle inverted or
// themed QRs unreliably, so this imagery intentionally does not follow the
// theme tokens. Direction-neutral — never mirrored for RTL.
export const QrCode: Component<{
  value: string
  label: string
  class?: string
}> = (props) => {
  const qr = createMemo(() => encode(props.value, { border: 0 }))
  const size = () => qr().size
  return (
    <svg
      class={props.class}
      role="img"
      aria-label={props.label}
      viewBox={`0 0 ${size()} ${size()}`}
      shape-rendering="crispEdges"
    >
      <rect width={size()} height={size()} fill="#ffffff" />
      <For each={qr().data}>
        {(row, y) => (
          <For each={row}>
            {(dark, x) => (
              <Show when={dark}>
                <rect x={x()} y={y()} width={1} height={1} fill="#000000" />
              </Show>
            )}
          </For>
        )}
      </For>
    </svg>
  )
}
