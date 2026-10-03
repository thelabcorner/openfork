import type { ServerSession } from "./server-session"

type SessionActivityRepairTarget = Pick<ServerSession, "set" | "apply">
export type SessionActivityRepairSnapshot = Record<string, { readonly type: "running" | "paused" }>

export function shouldApplyTelemetrySnapshot(
  previous: { readonly updatedAt: number; readonly sampledAt?: number } | undefined,
  next: { readonly updatedAt: number; readonly sampledAt?: number },
) {
  if (previous === undefined) return true
  if (next.updatedAt !== previous.updatedAt) return next.updatedAt > previous.updatedAt

  // updatedAt is a semantic-event watermark with millisecond resolution. A
  // fresh projection can legitimately observe a different same-millisecond
  // state. sampledAt is captured when the producer materializes the projection,
  // so it safely orders those ties inside one transport generation.
  if (next.sampledAt === undefined) return false
  if (previous.sampledAt === undefined) return true
  return next.sampledAt > previous.sampledAt
}

/**
 * Reconcile the renderer's working/paused projection from the authoritative,
 * bootstrap-free active-session snapshot after an SSE repair barrier.
 *
 * `changed` contains sessions that received a newer activity-bearing event
 * while the snapshot request was in flight. Those sessions are deliberately
 * skipped so a late HTTP response can never roll back newer stream state.
 */
export function applySessionActivityRepair(
  session: SessionActivityRepairTarget,
  active: SessionActivityRepairSnapshot,
  candidates: Iterable<string>,
  changed: ReadonlySet<string>,
) {
  const ids = new Set([...candidates, ...Object.keys(active)])
  for (const sessionID of ids) {
    if (!sessionID || changed.has(sessionID)) continue

    const state = active[sessionID]
    session.set("paused", sessionID, state?.type === "paused")
    session.apply({
      type: "session.status",
      properties: {
        sessionID,
        status: { type: state?.type === "running" ? "busy" : "idle" },
      },
    })
  }
}
