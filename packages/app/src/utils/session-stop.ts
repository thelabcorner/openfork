/**
 * Canonical client request for operator Stop. The server's generation-fenced
 * abort endpoint owns actual cancellation, containment and recovery.
 *
 * Deduplication only spans an in-flight request on the SAME server API object
 * and Session identity. A subsequent explicit Stop remains a fresh operation,
 * never inheriting a previous generation's success/failure.
 */
const pendingStops = new WeakMap<object, Map<string, Promise<void>>>()

export type SessionInterruptApi = {
  interrupt(input: { sessionID: string }): Promise<unknown>
}

export function stopSession(api: SessionInterruptApi, sessionID: string): Promise<void> {
  const owner = api as object
  const pending = pendingStops.get(owner) ?? new Map<string, Promise<void>>()
  const existing = pending.get(sessionID)
  if (existing) return existing
  const request = Promise.resolve().then(() => api.interrupt({ sessionID })).then((result) => {
    // Several first-party/local interrupt contracts return an explicit
    // false when a generation changed or containment could not be proven.
    // A successfully delivered HTTP response is not itself an acknowledged
    // Stop. NoContent/undefined (current protocol) and true (V1) remain valid.
    if (result === false ||
      (result !== null && typeof result === "object" && "data" in result && result.data === false)) {
      throw new Error("Session Stop was not confirmed: execution may still be active or recovery is fenced")
    }
  })
  pending.set(sessionID, request)
  pendingStops.set(owner, pending)
  void request.finally(() => {
    if (pending.get(sessionID) === request) pending.delete(sessionID)
    if (pending.size === 0 && pendingStops.get(owner) === pending) pendingStops.delete(owner)
  }).catch(() => {
    // The originating caller receives the rejection. Cleanup must not add an
    // unobserved rejection when a UI action intentionally handles it.
  })
  return request
}
