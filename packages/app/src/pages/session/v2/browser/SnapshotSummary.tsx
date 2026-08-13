// Snapshot summary chips: interactive/form/console-error/failed-request counts
// from the latest snapshot, rendered as a slim overlay on the browser canvas.
// Dense v2 zinc; pointer-events-none so the page stays interactive underneath.

import { For, Show, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { browserSnapshotStore } from "./browserSnapshotStore"

export function SnapshotSummary(props: { tabId: string }) {
  const language = useLanguage()
  const snapshot = createMemo(() => browserSnapshotStore.get(props.tabId))

  const items = createMemo(() => {
    const data = snapshot()
    if (!data) return [] as { key: "browser.summary.interactive" | "browser.summary.forms" | "browser.summary.consoleErrors" | "browser.summary.failedRequests"; count: number; tone?: "warn" }[]
    const result: { key: "browser.summary.interactive" | "browser.summary.forms" | "browser.summary.consoleErrors" | "browser.summary.failedRequests"; count: number; tone?: "warn" }[] = [
      { key: "browser.summary.interactive", count: data.summary.interactiveCount },
      { key: "browser.summary.forms", count: data.summary.formCount },
      { key: "browser.summary.consoleErrors", count: data.summary.consoleErrors, tone: data.summary.consoleErrors > 0 ? "warn" : undefined },
      { key: "browser.summary.failedRequests", count: data.summary.failedRequests, tone: data.summary.failedRequests > 0 ? "warn" : undefined },
    ]
    return result
  })

  return (
    <Show when={snapshot()}>
      <div
        class="pointer-events-none absolute bottom-1.5 left-1.5 z-30 flex items-center gap-1 rounded-[5px] bg-v2-background-bg-base/85 px-1.5 py-0.5 backdrop-blur-sm"
        data-browser-snapshot-summary
        aria-hidden="true"
      >
        <For each={items()}>
          {(item) => (
            <span
              class={`flex h-5 items-center gap-1 rounded-[3px] px-1.5 text-[10px] leading-none tabular-nums ${
                item.tone === "warn"
                  ? "text-v2-text-text-warning bg-v2-background-bg-layer-02"
                  : "text-v2-text-text-muted bg-v2-background-bg-layer-01"
              }`}
            >
              {language.t(item.key)} {item.count}
            </span>
          )}
        </For>
      </div>
    </Show>
  )
}
