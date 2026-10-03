export type SessionContextRefreshState = readonly [
  active: boolean,
  sessionID: string | undefined,
  phase: string | undefined,
  updatedAt: number | undefined,
]

/**
 * Decide whether an already-mounted Context pane needs a durable-history refresh.
 *
 * Initial query activation and session-key changes are owned by Solid Query.
 * This policy handles only post-mount invalidation: same-session catch-up after
 * a hidden interval, or a newer authoritative idle telemetry watermark after
 * Session cleanup/UsageRecord settlement.
 */
export function shouldRefreshSessionContext(
  next: SessionContextRefreshState,
  previous: SessionContextRefreshState | undefined,
) {
  const [active, sessionID, phase, updatedAt] = next
  if (!active || !sessionID || !previous) return false

  const sameSession = previous[1] === sessionID
  if (!sameSession) return false

  if (previous[0] === false) return true

  return (
    phase === "idle" &&
    updatedAt !== undefined &&
    previous[3] !== undefined &&
    (previous[2] !== "idle" || previous[3] !== updatedAt)
  )
}
