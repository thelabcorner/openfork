import { useEffect, useState } from "react"
import { getLedger, getPreview } from "../../utils/session-context-client"
import type { SessionContext } from "@opencode-ai/schema/session-context"

export function ContextLedger({ sessionID }: { sessionID: string }) {
  const [ledger, setLedger] = useState<SessionContext.Ledger | null>(null)
  const [preview, setPreview] = useState<{
    beforeTokens: number
    afterTokens: number
    removedTokens: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getLedger(sessionID)
      .then((l) => {
        if (!cancelled) setLedger(l)
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    getPreview(sessionID)
      .then((p) => {
        if (!cancelled) setPreview(p)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [sessionID])

  if (error) return <div className="text-sm text-red-500">Ledger error: {error}</div>
  if (!ledger) return <div className="text-sm opacity-60">Loading context…</div>

  const { totals } = ledger
  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between text-sm font-medium">
        <span>Context</span>
        <span className="tabular-nums">
          {totals.estimatedTokens.toLocaleString()} / ~{(totals.estimatedTokens + totals.estimatedTokensExcluded).toLocaleString()} tokens
        </span>
      </div>
      {preview && preview.removedTokens > 0 && (
        <div className="text-xs opacity-70">
          {preview.removedTokens.toLocaleString()} tokens removed from context · {totals.excludedCount} message(s) excluded
        </div>
      )}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="rounded bg-muted p-2">
          <div className="opacity-60">Messages</div>
          <div className="text-sm font-medium">{totals.messageCount}</div>
        </div>
        <div className="rounded bg-muted p-2">
          <div className="opacity-60">Excluded</div>
          <div className="text-sm font-medium">{totals.excludedCount}</div>
        </div>
        <div className="rounded bg-muted p-2">
          <div className="opacity-60">Edited</div>
          <div className="text-sm font-medium">{totals.editedCount}</div>
        </div>
      </div>
      <div className="space-y-1 max-h-64 overflow-auto pr-1">
        {ledger.entries.map((e) => (
          <div
            key={e.messageID}
            className={`flex items-center gap-2 rounded px-2 py-1 text-xs ${e.excluded ? "opacity-40 line-through" : ""} ${e.pinned ? "bg-amber-500/10" : "bg-muted/50"}`}
            title={`${e.role} · ${e.tokenEstimate} tokens · ${e.partCount} parts${e.hasSignedReasoning ? " · signed reasoning (locked)" : ""}`}
          >
            <span className="min-w-0 flex-1 truncate">{e.preview || e.type}</span>
            <span className="shrink-0 tabular-nums opacity-60">{e.tokenEstimate}</span>
            {e.edited && <span className="shrink-0 rounded bg-blue-500/20 px-1">edited</span>}
            {e.pinned && <span className="shrink-0 rounded bg-amber-500/20 px-1">📌</span>}
            {e.hasSignedReasoning && <span className="shrink-0 opacity-60" title="Signed reasoning — edit/exclude blocked">🔒</span>}
          </div>
        ))}
      </div>
      {ledger.entries.some((e) => e.excluded || e.edited) && (
        <div className="text-[11px] opacity-60">
          Spend is historical and unchanged by context edits — occupancy shows current effective context.
        </div>
      )}
    </div>
  )
}
