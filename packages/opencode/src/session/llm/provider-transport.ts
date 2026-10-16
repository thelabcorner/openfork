/**
 * Physical LLM request cancellation owned by the process, not by the heavyweight
 * provider service graph. Session IDs are globally unique durable identities.
 *
 * One LLM attempt registers its exact AbortController; SessionRunState signals
 * registered transports BEFORE joining cancellation / instance shutdown.
 * Scope release unregisters; neither the registration nor cancellation path
 * instantiates a provider, loads an Instance, or touches SQLite.
 *
 * The process-global symbol survives distinct bundled module copies of this
 * small owner (same reasoning as SessionRunState's activation registry).
 */
const REGISTRY_KEY = Symbol.for("openfork.session.provider-transports.v1")

type Registry = Map<string, Set<AbortController>>

function registry(): Registry {
  const processGlobal = globalThis as typeof globalThis & { [key: symbol]: unknown }
  const previous = processGlobal[REGISTRY_KEY]
  if (previous instanceof Map) return previous as Registry
  const created: Registry = new Map()
  processGlobal[REGISTRY_KEY] = created
  return created
}

/** Returns an idempotent release owned by the exact physical attempt. */
export function registerProviderTransport(sessionID: string, controller: AbortController): () => void {
  const entries = registry()
  const group = entries.get(sessionID) ?? new Set<AbortController>()
  group.add(controller)
  entries.set(sessionID, group)
  let released = false
  return () => {
    if (released) return
    released = true
    group.delete(controller)
    if (group.size === 0 && entries.get(sessionID) === group) entries.delete(sessionID)
  }
}

/** Purely in-process signal; never claims durable Session ownership or release. */
export function abortSessionTransports(sessionID: string): number {
  const group = registry().get(sessionID)
  if (!group) return 0
  const active = [...group].filter((controller) => !controller.signal.aborted)
  for (const controller of active) controller.abort()
  return active.length
}
