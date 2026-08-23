import { For, Show, createEffect, createSignal } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { clearPipeline, pipelineEntries } from "@/utils/model-pipeline-debug"

// TEMPORARY debug panel for the model-catalog pricing pipeline (Ctrl+Shift+M).
// Remove together with utils/model-pipeline-debug.ts.

export function ModelPipelineDebugOverlay() {
  const [open, setOpen] = createSignal(false)
  let seenCount = pipelineEntries().length

  createEffect(() => {
    const count = pipelineEntries().length
    if (count > seenCount) setOpen(true)
    seenCount = count
  })

  makeEventListener(window, "keydown", (event) => {
    if (event.ctrlKey && event.shiftKey && (event.key === "M" || event.key === "m")) {
      event.preventDefault()
      setOpen((value) => !value)
    }
  })

  return (
    <Show when={open()}>
      <div class="fixed bottom-3 right-3 z-[9999] flex max-h-[60vh] w-[620px] flex-col overflow-hidden rounded-md border border-white/15 bg-black/90 font-mono text-[11px] leading-4 text-lime-200 shadow-xl">
        <div class="flex items-center justify-between border-b border-white/10 px-2 py-1">
          <span class="font-semibold">model-pipeline debug — Ctrl+Shift+M</span>
          <div class="flex gap-2">
            <button type="button" class="underline" onClick={clearPipeline}>
              clear
            </button>
            <button type="button" class="underline" onClick={() => setOpen(false)}>
              close
            </button>
          </div>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          <Show when={pipelineEntries().length > 0} fallback={<div class="text-white/40">no entries yet</div>}>
            <For each={pipelineEntries()}>
              {(entry) => (
                <div class="whitespace-pre-wrap break-all">
                  <span class="text-white/40">{entry.at}</span>{" "}
                  <span class="text-cyan-300">[{entry.stage}]</span> {entry.detail}
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </Show>
  )
}
