import { useEffect, useState } from "react"
import { getOpsHistory, applyContextOps } from "../../utils/session-context-client"

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

export function ContextHistory({ sessionID, onChange }: { sessionID: string; onChange?: () => void }) {
  const [history, setHistory] = useState<Array<{ id: string; batchID: string; operations: any[]; timestamp: number }>>([])
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = () => {
    getOpsHistory(sessionID)
      .then(setHistory)
      .catch(() => {})
  }

  useEffect(() => {
    refresh()
  }, [sessionID])

  const undo = async (entry: (typeof history)[number]) => {
    const inverted = invertOps(entry.operations)
    if (inverted.length === 0) return
    setBusy(entry.id)
    try {
      await applyContextOps(sessionID, inverted)
      refresh()
      onChange?.()
    } finally {
      setBusy(null)
    }
  }

  if (history.length === 0) return <div className="text-xs opacity-60">No context changes yet.</div>

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">Context History</div>
      <div className="space-y-1">
        {history
          .slice()
          .reverse()
          .map((entry) => (
            <div key={entry.id} className="flex items-center gap-2 rounded border px-2 py-1.5 text-xs">
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  {entry.operations.length === 1 ? formatOp(entry.operations[0]) : `${entry.operations.length} operations`}
                </div>
                <div className="opacity-60">{new Date(entry.timestamp).toLocaleString()}</div>
              </div>
              <button
                className="shrink-0 rounded bg-muted px-2 py-1 text-[11px] hover:bg-muted/80 disabled:opacity-50"
                disabled={!!busy}
                onClick={() => undo(entry)}
              >
                {busy === entry.id ? "…" : "Undo"}
              </button>
            </div>
          ))}
      </div>
    </div>
  )
}
