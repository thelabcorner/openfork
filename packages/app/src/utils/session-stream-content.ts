/**
 * Session events whose payload is reconstructible content rather than global
 * lifecycle/notification state. A background timeline already discards these
 * events and marks its cache stale; keeping the classification here lets the
 * SSE reader make the same decision before adaptation, byte accounting and
 * renderer queue fan-out.
 */
const EXACT_CONTENT_EVENTS = new Set([
  // Legacy/v1 materialized message content.
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "message.part.delta",

  // Compatibility/native session content that is reconstructed by session
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

export function isSessionStreamContentEvent(type: string) {
  if (EXACT_CONTENT_EVENTS.has(type)) return true
  return CONTENT_PREFIXES.some((prefix) => type.startsWith(prefix))
}
