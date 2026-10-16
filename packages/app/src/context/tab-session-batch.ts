import type { ServerConnection } from "./server"
import type { SessionTab, Tab } from "./tabs"

/**
 * Resolve one bulk tab operation against the current authoritative store.
 * Unlike repeated addSessionTab, this performs one scan of existing sessions
 * and one pass over incoming IDs; duplicate inputs and preexisting tabs remain
 * no-ops. Return only the new entries so Solid receives one store mutation.
 */
export function missingSessionTabs(
  current: readonly Tab[],
  server: ServerConnection.Key,
  incoming: Iterable<string>,
): SessionTab[] {
  const existing = new Set<string>()
  for (const tab of current) {
    if (tab.type === "session" && tab.server === server) existing.add(tab.sessionId)
  }
  const missing: SessionTab[] = []
  for (const sessionId of incoming) {
    if (existing.has(sessionId)) continue
    existing.add(sessionId)
    missing.push({ type: "session", server, sessionId })
  }
  return missing
}

/** JS engines cap the number of call arguments. An enormous group must not
 * throw RangeError when a single push(...many) exceeds that implementation
 * limit. Bounded slices stay inside the same Solid produce transaction.
 */
export function appendSessionTabs(target: Tab[], additions: readonly SessionTab[]) {
  const chunk = 2_048
  for (let offset = 0; offset < additions.length; offset += chunk)
    target.push(...additions.slice(offset, offset + chunk))
}