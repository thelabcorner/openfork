/**
 * The renderer's activity proof boundary for BOTH Core/V2 Sessions and the
 * generation-fenced V1 Session processor. Display state is not authority:
 * callers must pass live coordinator keys and the exact execution-owner
 * projection, never cached telemetry phases, UI busy state or heartbeat rows.
 *
 * An interrupted Session is NOT running. Its external tool effects may still
 * be unknown, so it stays visible as actionable/recovery-needed instead of
 * being silently omitted or promoted to a false spinner.
 */
export type ProofState = { readonly type: "busy" | "interrupted" }
export type ActivityState = { readonly type: "running" | "paused" | "interrupted" }

export function projectSessionActivity(
  liveCore: ReadonlySet<string>,
  v1: ReadonlyMap<string, ProofState>,
  paused: ReadonlySet<string>,
): Record<string, ActivityState> {
  const states = new Map<string, ActivityState>()
  for (const sessionID of liveCore) states.set(sessionID, { type: "running" })
  for (const [sessionID, proof] of v1) {
    if (proof.type === "busy") states.set(sessionID, { type: "running" })
    else if (!states.has(sessionID)) states.set(sessionID, { type: "interrupted" })
  }
  // Pause is an explicit durable lifecycle decision. This remains visible
  // while older/migrated generation fields are reconciled.
  for (const sessionID of paused) states.set(sessionID, { type: "paused" })
  return Object.fromEntries(states)
}
