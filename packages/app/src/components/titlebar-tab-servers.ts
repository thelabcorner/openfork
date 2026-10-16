import type { Tab } from "@/context/tabs"
import type { ServerConnection } from "@/context/server"

/** The strip needs full server contexts only for session/group tabs.
 * Build one reactive projection per strip rather than invoking the global
 * context resolver once from every mounted tab on connection-list revisions.
 * Draft/app tabs intentionally do not bootstrap server sync.
 */
export function indexTabServerContexts<Connection, Context>(
  tabs: readonly Tab[],
  connections: ReadonlyMap<ServerConnection.Key, Connection>,
  ensure: (connection: Connection) => Context,
) {
  const contexts = new Map<ServerConnection.Key, Context>()
  for (const tab of tabs) {
    if (tab.type !== "session" && tab.type !== "group") continue
    if (contexts.has(tab.server)) continue
    const connection = connections.get(tab.server)
    if (connection) contexts.set(tab.server, ensure(connection))
  }
  return contexts
}