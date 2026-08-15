import type { ServerCtx } from "@/context/global"

export type TabSessionState = "idle" | "working" | "paused"

// The `session_paused` accessor lands with the app-state sidecar (slice 2); read it
// defensively so the tab degrades to today's behavior until that ships. It is NEVER
// derived from `!session_working` — a paused session must not flicker through the
// working state during the interrupt-cleanup window (swarm-tab-stop-pause §4.2, S4).
const sessionPaused = (ctx: ServerCtx | undefined, sessionID: string) =>
  (ctx?.sync.session.data as { session_paused?: (id: string) => boolean }).session_paused?.(sessionID) ?? false

export function tabSessionState(ctx: ServerCtx | undefined, sessionID: string | undefined): TabSessionState {
  if (!ctx || !sessionID) return "idle"
  if (sessionPaused(ctx, sessionID)) return "paused"
  return ctx.sync.session.data.session_working(sessionID) ? "working" : "idle"
}
