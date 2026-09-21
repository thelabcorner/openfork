import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { getLedger, getPreview } from "../../utils/session-context-client"
import type { SessionContext } from "@opencode-ai/schema/session-context"

type Preview = {
  beforeTokens: number
  afterTokens: number
  removedTokens: number
}

export function ContextLedger(props: { sessionID: string }) {
  const [ledger, setLedger] = createSignal<SessionContext.Ledger>()
  const [preview, setPreview] = createSignal<Preview>()
  const [error, setError] = createSignal<string>()

  createEffect(() => {
    const sessionID = props.sessionID
    let cancelled = false
    setError(undefined)
    getLedger(sessionID)
      .then((value) => {
        if (!cancelled) setLedger(value)
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause))
      })
    getPreview(sessionID)
      .then((value) => {
        if (!cancelled) setPreview(value)
      })
      .catch(() => {})
    onCleanup(() => {
      cancelled = true
    })
  })

  return (
    <Show
      when={!error()}
      fallback={<div class="text-sm text-red-500">Ledger error: {error()}</div>}
    >
      <Show when={ledger()} fallback={<div class="text-sm opacity-60">Loading context…</div>}>
        {(current) => (
          <div class="rounded-md border p-3 space-y-2">
            <div class="flex items-center justify-between text-sm font-medium">
              <span>Context</span>
              <span class="tabular-nums">
                {current().totals.estimatedTokens.toLocaleString()} / ~
                {(current().totals.estimatedTokens + current().totals.estimatedTokensExcluded).toLocaleString()} tokens
              </span>
            </div>
            <Show when={preview() && preview()!.removedTokens > 0}>
              <div class="text-xs opacity-70">
                {preview()!.removedTokens.toLocaleString()} tokens removed from context ·{" "}
                {current().totals.excludedCount} message(s) excluded
              </div>
            </Show>
            <div class="grid grid-cols-3 gap-2 text-xs">
              <div class="rounded bg-muted p-2">
                <div class="opacity-60">Messages</div>
                <div class="text-sm font-medium">{current().totals.messageCount}</div>
              </div>
              <div class="rounded bg-muted p-2">
                <div class="opacity-60">Excluded</div>
                <div class="text-sm font-medium">{current().totals.excludedCount}</div>
              </div>
              <div class="rounded bg-muted p-2">
                <div class="opacity-60">Edited</div>
                <div class="text-sm font-medium">{current().totals.editedCount}</div>
              </div>
            </div>
            <div class="space-y-1 max-h-64 overflow-auto pr-1">
              <For each={current().entries}>
                {(entry) => (
                  <div
                    class={`flex items-center gap-2 rounded px-2 py-1 text-xs ${entry.excluded ? "opacity-40 line-through" : ""} ${entry.pinned ? "bg-amber-500/10" : "bg-muted/50"}`}
                    title={`${entry.role} · ${entry.tokenEstimate} tokens · ${entry.partCount} parts${entry.hasSignedReasoning ? " · signed reasoning (locked)" : ""}`}
                  >
                    <span class="min-w-0 flex-1 truncate">{entry.preview || entry.type}</span>
                    <span class="shrink-0 tabular-nums opacity-60">{entry.tokenEstimate}</span>
                    <Show when={entry.edited}>
                      <span class="shrink-0 rounded bg-blue-500/20 px-1">edited</span>
                    </Show>
                    <Show when={entry.pinned}>
                      <span class="shrink-0 rounded bg-amber-500/20 px-1">📌</span>
                    </Show>
                    <Show when={entry.hasSignedReasoning}>
                      <span class="shrink-0 opacity-60" title="Signed reasoning — edit/exclude blocked">
                        🔒
                      </span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
            <Show when={current().entries.some((entry) => entry.excluded || entry.edited)}>
              <div class="text-[11px] opacity-60">
                Spend is historical and unchanged by context edits — occupancy shows current effective context.
              </div>
            </Show>
          </div>
        )}
      </Show>
    </Show>
  )
}
