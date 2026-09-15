/**
 * Reconstructible session content that can be omitted from a subscriber which
 * is not currently rendering that session. Lifecycle/status/permission/question
 * events are intentionally NOT included: those remain live for every client.
 *
 * Keep this classification in Core so the server-side SSE admission filter and
 * the renderer-side final safety gate cannot drift apart.
 */
const EXACT_CONTENT_EVENTS = new Set([
  // Legacy/v1 materialized message content.
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "message.part.delta",

  // Compatibility/native session content reconstructed by authoritative
  // message hydration when a hidden session becomes foreground again.
  "session.agent.selected",
  "session.model.selected",
  "session.synthetic",
  "session.skill.activated",
  "session.next.prompted",
  "session.next.prompt.admitted",
  "session.next.context.updated",
  "session.next.synthetic",
  "session.next.agent.switched",
  "session.next.model.switched",
])

const CONTENT_PREFIXES = [
  "session.input.",
  "session.text.",
  "session.reasoning.",
  "session.tool.",
  "session.shell.",
  "session.step.",
  "session.compaction.",
  "session.next.shell.",
  "session.next.step.",
  "session.next.text.",
  "session.next.reasoning.",
  "session.next.tool.",
  "session.next.compaction.",
] as const

export const STREAM_INTEREST_SUBSCRIBER_HEADER = "x-opencode-stream-subscriber"
export const STREAM_INTEREST_SESSIONS_HEADER = "x-opencode-stream-sessions"
export const STREAM_INTEREST_MAX_SESSIONS = 128
export const STREAM_INTEREST_MAX_SUBSCRIBER_CHARS = 128
export const STREAM_INTEREST_MAX_SESSION_CHARS = 256

export const STREAM_SESSION_STALE_EVENT = "server.stream.session-stale"
export const STREAM_PROGRESS_EVENT = "server.stream.progress"

export function isSessionStreamContentEvent(type: string) {
  if (EXACT_CONTENT_EVENTS.has(type)) return true
  return CONTENT_PREFIXES.some((prefix) => type.startsWith(prefix))
}

type EventEnvelope = {
  readonly type?: unknown
  readonly data?: unknown
  readonly properties?: unknown
}

const sessionIDFromObject = (value: unknown) => {
  if (!value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  if (typeof record.sessionID === "string") return record.sessionID
  for (const key of ["info", "part", "message"] as const) {
    const nested = record[key]
    if (!nested || typeof nested !== "object") continue
    const sessionID = (nested as Record<string, unknown>).sessionID
    if (typeof sessionID === "string") return sessionID
  }
}

/**
 * Extract the owning session from either the native `{ data }` shape or the
 * legacy `{ properties }` compatibility shape. Unknown shapes deliberately
 * return undefined so a server-side filter fails open rather than dropping an
 * event whose ownership it cannot prove.
 */
export function sessionStreamContentSessionID(event: EventEnvelope) {
  const direct = sessionIDFromObject(event.data)
  if (direct) return direct
  return sessionIDFromObject(event.properties)
}

export function isValidStreamInterestSessionID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= STREAM_INTEREST_MAX_SESSION_CHARS
}

export function normalizeStreamInterestSessions(values: Iterable<unknown>) {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!isValidStreamInterestSessionID(value) || seen.has(value)) continue
    seen.add(value)
    result.push(value)
    if (result.length >= STREAM_INTEREST_MAX_SESSIONS) break
  }
  result.sort()
  return result
}
