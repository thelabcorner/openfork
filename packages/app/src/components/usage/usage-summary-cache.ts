/** Keyed by the server identity, not just the time range: never reuse a
 * usage snapshot from a different connected sidecar or project. */
export function usageSummaryCacheKey(serverScope: string, windowKey: string, projectID: string | null) {
  return `${serverScope}\u0000${windowKey}\u0000${projectID ?? ""}`
}