import { For, Show, createMemo } from "solid-js"

/**
 * The call's arguments, as chips.
 *
 * This replaces the pretty-printed `JSON.stringify(input)` block the generic
 * body used to open with. On a phone that block was usually taller than the
 * output it sat above, and braces and quotes carry no information the reader
 * needs — the shape is already known, only the values matter.
 */

const SKIP = new Set(["action", "mode"])

function scalar(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.length ? `${value.length} items` : undefined
  return undefined
}

export function ToolParams(props: { input?: Record<string, unknown>; skip?: string[] }) {
  const entries = createMemo(() => {
    const input = props.input
    if (!input) return []
    const skip = new Set([...SKIP, ...(props.skip ?? [])])
    return Object.entries(input)
      .filter(([key]) => !skip.has(key))
      .flatMap(([key, raw]) => {
        const value = scalar(raw)
        if (value === undefined || value === "") return []
        // Long values get their own full-width row so they stay readable.
        return [{ key, value, long: value.length > 32 }]
      })
  })

  return (
    <Show when={entries().length > 0}>
      <div class="tparams">
        <For each={entries()}>
          {(entry) => (
            <span class={`tparam ${entry.long ? "long" : ""}`}>
              <span class="tparam-key">{entry.key}</span>
              <span class="tparam-value">{entry.value}</span>
            </span>
          )}
        </For>
      </div>
    </Show>
  )
}
