import type { ServerConnection } from "./server"

/**
 * A canonical server *key* is not a complete connection/principal identity:
 * sidecar and SSH URLs can rotate under the same key, and HTTP credentials
 * can change without changing the URL. Cache lifetime decisions must compare
 * these transport fields, not display names or object reference identity.
 */
export function sameServerTransport(a: ServerConnection.Any, b: ServerConnection.Any) {
  if (a === b) return true
  if (
    a.type !== b.type ||
    a.http.url !== b.http.url ||
    a.http.username !== b.http.username ||
    a.http.password !== b.http.password
  ) return false
  if (a.type === "http" && b.type === "http") return a.authToken === b.authToken
  if (a.type === "ssh" && b.type === "ssh") return a.host === b.host
  if (a.type === "sidecar" && b.type === "sidecar") {
    return a.variant === b.variant && (a.variant !== "wsl" || (
      b.variant === "wsl" && a.distro === b.distro
    ))
  }
  return false
}

/** Never retain a reactive Solid proxy as the 'before' state: when the live
 * connection mutates in place the proxy would read the new credentials too.
 * Keep an in-memory scalar snapshot; never stringify/log/auth-key it. */
export function snapshotServerTransport(conn: ServerConnection.Any): ServerConnection.Any {
  return { ...conn, http: { ...conn.http } }
}