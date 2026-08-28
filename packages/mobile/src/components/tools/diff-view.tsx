import { For, Show, createMemo } from "solid-js"
import type { JSX } from "solid-js"
import { parseUnifiedDiff, synthesizeDiff, type ParsedDiff } from "./diff"

export function DiffView(props: {
  patch?: string
  before?: string
  after?: string
  maxHeightPx?: number
  extra?: JSX.Element
}) {
  const parsed = createMemo<ParsedDiff | undefined>(() => {
    if (props.patch && props.patch.trim()) return parseUnifiedDiff(props.patch)
    if (props.before !== undefined || props.after !== undefined) return synthesizeDiff(props.before ?? "", props.after ?? "")
    return undefined
  })

  return (
    <Show when={parsed()} fallback={props.extra}>
      {(diff) => (
        <div class="tdiff" style={{ "max-height": `${props.maxHeightPx ?? 300}px` }}>
          <For each={diff().hunks}>
            {(hunk) => (
              <>
                <div class="tdiff-hunk tnum">{hunk.header}</div>
                <For each={hunk.lines}>
                  {(line) => (
                    <div class={`tdiff-row ${line.kind}`}>
                      <span class="tdiff-gutter tnum">
                        <span>{line.oldNo ?? ""}</span>
                        <span>{line.newNo ?? ""}</span>
                      </span>
                      <span class="tdiff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</span>
                      <code>{line.text || "\u00A0"}</code>
                    </div>
                  )}
                </For>
              </>
            )}
          </For>
        </div>
      )}
    </Show>
  )
}
