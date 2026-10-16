/**
 * Durable tool lifecycle transitions must never be mistaken for cosmetic
 * progress updates. In particular, Shell emits queueStartedAt immediately
 * before waiting for a process slot, and startedAt immediately after admission.
 * A silent process may never emit another progress update, so throttling that
 * transition would leave the UI saying "queued" throughout actual execution.
 */
export function createToolMetadataThrottle(windowMs = 500) {
  type Phase = "queued" | "executing"
  type Entry = { at: number; phase?: Phase }
  const previous = new Map<string, Entry>()

  return (callID: string | undefined, metadata?: Record<string, unknown>, now = Date.now()): boolean => {
    // Unattributed calls preserve the existing no-throttle behavior.
    if (callID === undefined) return true

    const phase: Phase | undefined =
      typeof metadata?.queueStartedAt === "number" && Number.isFinite(metadata.queueStartedAt)
        ? typeof metadata.startedAt === "number" && Number.isFinite(metadata.startedAt)
          ? "executing"
          : "queued"
        : undefined
    const prior = previous.get(callID)

    // A new execution phase is mandatory, even if only milliseconds have
    // elapsed since the preceding queued/progress update. Repeated stdout
    // previews in the same phase remain throttled.
    const transition = phase !== undefined && phase !== prior?.phase
    if (prior && now >= prior.at && now - prior.at < windowMs && !transition) return false

    previous.set(callID, { at: now, phase: phase ?? prior?.phase })
    // Bound state across exceptionally long sessions with many tool calls.
    if (previous.size > 2_000) {
      for (const [id, entry] of previous) {
        if (now - entry.at > windowMs * 2) previous.delete(id)
      }
    }
    return true
  }
}
