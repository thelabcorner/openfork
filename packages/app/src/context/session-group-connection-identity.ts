import type { ServerConnection } from "./server"
import { sameServerTransport, snapshotServerTransport } from "./server-transport-identity"

/** A connection key is not a transport/auth principal: sidecars and SSH
 * entries can keep the same key while their HTTP proxy URL or credentials
 * change. Compare the material connection fields without putting passwords
 * or tokens in a log, query key, or persistent cache.
 *
 * Display-only labels are deliberately ignored; renaming a server must
 * not invalidate an otherwise fresh SessionGroup snapshot.
 */
export function sameSessionGroupConnection(
  left: ServerConnection.Any,
  right: ServerConnection.Any,
): boolean {
  return sameServerTransport(left, right)
}

/**
 * Keep scalar snapshots, not Solid store proxies. Live connection objects
 * may be mutated in place, so retaining an old proxy alone would compare the
 * new URL/credentials against themselves and silently reuse another identity's
 * group-member data.
 */
export function createSessionGroupConnectionRevisions(keyOf: (conn: ServerConnection.Any) => ServerConnection.Key) {
  let previous = new Map<ServerConnection.Key, ServerConnection.Any>()
  return {
    update(current: readonly ServerConnection.Any[]) {
      const next = new Map<ServerConnection.Key, ServerConnection.Any>()
      // The authoritative ServerConnection.key remains the only owner of
      // canonical key construction. Pure tests inject its expected mapping.
      for (const conn of current) {
        const key = keyOf(conn)
        next.set(key, snapshotServerTransport(conn))
      }
      const removed: ServerConnection.Key[] = []
      const changed: ServerConnection.Key[] = []
      for (const [key, old] of previous) {
        const conn = next.get(key)
        if (!conn) removed.push(key)
        else if (!sameSessionGroupConnection(old, conn)) changed.push(key)
      }
      previous = next
      return { removed, changed }
    },
  }
}