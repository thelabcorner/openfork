import { createEffect, createSignal, For, Show } from "solid-js"
import { getOpsHistory, applyContextOps } from "../../utils/session-context-client"

type HistoryEntry = {
  id: string
  batchID: string
  operations: any[]
  timestamp: number
}

function formatOp(op: any) {
  switch (op.type) {
    case "message.exclude":
      return `Removed message ${op.messageID.slice(0, 8)}…`
    case "message.include":
      return `Restored message ${op.messageID.slice(0, 8)}…`
    case "text.replace":
      return `Edited message ${op.messageID.slice(0, 8)}…`
    case "text.restore":
      return `Restored original for ${op.messageID.slice(0, 8)}…`
    case "message.pin":
      return `Pinned ${op.messageID.slice(0, 8)}…`
    case "message.unpin":
      return `Unpinned ${op.messageID.slice(0, 8)}…`
    case "tool.collapse":
      return `Collapsed tool output ${op.partID.slice(0, 8)}…`
    default:
      return op.type
  }
}

function invertOps(ops: any[]): any[] {
  return ops
    .slice()
    .reverse()
    .map((op) => {
      switch (op.type) {
        case "message.exclude":
          return { type: "message.include", messageID: op.messageID }
        case "message.include":
          return { type: "message.exclude", messageID: op.messageID }
        case "text.replace":
          return { type: "text.restore", messageID: op.messageID, partID: op.partID }
        case "message.pin":
          return { type: "message.unpin", messageID: op.messageID }
        case "message.unpin":
          return { type: "message.pin", messageID: op.messageID }
        default:
          return null
      }
    })
    .filter(Boolean)
}

export function ContextHistory(props: { sessionID: string; onChange?: () => void }) {
  const [history, setHistory] = createSignal<HistoryEntry[]>([])
  const [busy, setBusy] = createSignal<string>()

  const refresh = () => {
    getOpsHistory(props.sessionID)
      .then(setHistory)
      .catch(() => {})
  }

  createEffect(() => {
    props.sessionID
    refresh()
  })

  const undo = async (entry: HistoryEntry) => {
    const inverted = invertOps(entry.operations)
    if (inverted.length === 0) return
    setBusy(entry.id)
    try {
      await applyContextOps(props.sessionID, inverted)
      refresh()
      props.onChange?.()
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Show when={history().length > 0} fallback={<div class="text-xs opacity-60">No context changes yet.</div>}>
      <div class="space-y-2">
        <div class="text-sm font-medium">Context History</div>
        <div class="space-y-1">
          <For each={[...history()].reverse()}>
            {(entry) => (
              <div class="flex items-center gap-2 rounded border px-2 py-1.5 text-xs">
                <div class="min-w-0 flex-1">
                  <div class="truncate">
                    {entry.operations.length === 1
                      ? formatOp(entry.operations[0])
                      : `${entry.operations.length} operations`}
                  </div>
                  <div class="opacity-60">{new Date(entry.timestamp).toLocaleString()}</div>
                </div>
                <button
                  class="shrink-0 rounded bg-muted px-2 py-1 text-[11px] hover:bg-muted/80 disabled:opacity-50"
                  disabled={!!busy()}
                  onClick={() => void undo(entry)}
                >
                  {busy() === entry.id ? "…" : "Undo"}
                </button>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}
