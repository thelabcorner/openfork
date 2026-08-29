import { Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import type { SortDirection } from "./usage-sort"

/** Clickable column header with a sort direction chevron, for use inside a table's header grid row. */
export function SortHeader<Col extends string>(props: {
  label: string
  column: Col
  active: Col
  direction: SortDirection
  align?: "left" | "right"
  onClick: (column: Col) => void
}) {
  const isActive = () => props.active === props.column
  return (
    <button
      type="button"
      class="flex items-center gap-0.5 text-[8px] font-[600] uppercase leading-3 tracking-[0.03em] text-v2-text-text-faint outline-none transition-colors hover:text-v2-text-text-muted"
      classList={{ "justify-end": props.align === "right", "text-v2-text-text-base": isActive() }}
      onClick={() => props.onClick(props.column)}
      aria-sort={isActive() ? (props.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <span>{props.label}</span>
      <Show when={isActive()}>
        <Icon
          name="outline-chevron-down"
          size="small"
          class="shrink-0 transition-transform"
          classList={{ "rotate-180": props.direction === "asc" }}
        />
      </Show>
    </button>
  )
}
