import {
  STREAM_INTEREST_MAX_SESSION_CHARS,
  STREAM_INTEREST_MAX_SESSIONS,
  STREAM_INTEREST_MAX_SUBSCRIBER_CHARS,
  STREAM_INTEREST_SESSIONS_HEADER,
  STREAM_INTEREST_SUBSCRIBER_HEADER,
  normalizeStreamInterestSessions,
} from "@opencode-ai/core/session-stream-content"

export type EventStreamInterest = {
  readonly subscriber: string
  /** undefined means compatibility/pass-through mode. */
  sessions: Set<string> | undefined
  /** Sessions for which this connection already emitted a stale marker. */
  readonly suppressed: Set<string>
}

const registry = new Map<string, EventStreamInterest>()
// A subscriber can remain connected for days while many distinct sessions run
// in the background. Dirty latches are only an optimization (they collapse a
// flood to one stale marker per session), so never let that cache grow without
// bound. Set iteration is insertion ordered, giving us a tiny FIFO with no
// extra allocation on the hot suppression path.
export const EVENT_STREAM_SUPPRESSED_CAP = 2048

const validSubscriber = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= STREAM_INTEREST_MAX_SUBSCRIBER_CHARS

function parseSessionsHeader(raw: string | undefined) {
  if (raw === undefined) return undefined
  // Header presence is the capability signal. Invalid content therefore fails
  // open (undefined) rather than accidentally suppressing every session.
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value) || value.length > STREAM_INTEREST_MAX_SESSIONS) return undefined
    if (value.some((item) => typeof item !== "string" || item.length > STREAM_INTEREST_MAX_SESSION_CHARS)) return undefined
    return normalizeStreamInterestSessions(value)
  } catch {
    return undefined
  }
}

export function eventStreamInterestFromHeaders(headers: Record<string, string | undefined>) {
  const subscriber = headers[STREAM_INTEREST_SUBSCRIBER_HEADER]
  if (!validSubscriber(subscriber)) return undefined
  return {
    subscriber,
    sessions: parseSessionsHeader(headers[STREAM_INTEREST_SESSIONS_HEADER]),
  }
}

/**
 * Register one concrete SSE body. Reusing a subscriber id during reconnect is
 * safe: the newest body replaces the registry pointer and an older body's
 * finalizer cannot delete the newer entry.
 */
export function registerEventStreamInterest(
  subscriber: string | undefined,
  sessions: readonly string[] | undefined,
): EventStreamInterest | undefined {
  if (!validSubscriber(subscriber)) return undefined
  const state: EventStreamInterest = {
    subscriber,
    sessions: sessions === undefined ? undefined : new Set(normalizeStreamInterestSessions(sessions)),
    suppressed: new Set(),
  }
  registry.set(subscriber, state)
  return state
}

export function unregisterEventStreamInterest(state: EventStreamInterest | undefined) {
  if (!state) return
  if (registry.get(state.subscriber) === state) registry.delete(state.subscriber)
}

/** Update a live subscriber. False means the stream is no longer registered. */
export function updateEventStreamInterest(subscriber: string, sessions: readonly string[]) {
  if (!validSubscriber(subscriber) || sessions.length > STREAM_INTEREST_MAX_SESSIONS) return false
  const state = registry.get(subscriber)
  if (!state) return false
  const normalized = normalizeStreamInterestSessions(sessions)
  // If invalid entries were silently dropped, fail closed on the CONTROL
  // request rather than interpreting a malformed caller as an empty interest
  // set. The initial header parser remains fail-open for compatibility.
  if (normalized.length !== new Set(sessions).size) return false
  const next = new Set(normalized)
  // Once a session is admitted again, the client will repair/hydrate it before
  // consuming content. Clear the dirty latch so a later background period can
  // emit exactly one fresh stale marker.
  for (const sessionID of next) state.suppressed.delete(sessionID)
  state.sessions = next
  return true
}

export function eventStreamAllowsSession(state: EventStreamInterest | undefined, sessionID: string) {
  return state?.sessions === undefined || state.sessions.has(sessionID)
}

/** Returns true only for the first suppressed frame in the current dirty era. */
export function markEventStreamSessionSuppressed(state: EventStreamInterest | undefined, sessionID: string) {
  if (!state || state.sessions === undefined || state.sessions.has(sessionID)) return false
  if (state.suppressed.has(sessionID)) return false
  if (state.suppressed.size >= EVENT_STREAM_SUPPRESSED_CAP) {
    const oldest = state.suppressed.values().next().value
    if (oldest !== undefined) state.suppressed.delete(oldest)
  }
  state.suppressed.add(sessionID)
  return true
}

export function eventStreamInterestRegistrySize() {
  return registry.size
}

/** Test seam only. */
export function clearEventStreamInterestRegistry() {
  registry.clear()
}
