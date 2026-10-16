export type SidecarControlFetchInput = {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

export const MAX_SIDE_CAR_CONTROL_REQUEST_BYTES = 16 * 1024 * 1024

const CONTROL_PATHS = [
  /^\/global\/event\/interest$/,
  /^\/permission\/[^/]+\/reply$/,
  /^\/question\/[^/]+\/(?:reply|reject)$/,
  /^\/session$/,
  /^\/session\/[^/]+\/(?:prompt_async|abort|pause|resume|permissions\/[^/]+)$/,
  /^\/session\/[^/]+\/goal\/(?:prepare|dispatch)$/,
  /^\/api\/session$/,
  /^\/api\/session\/[^/]+\/(?:prompt|interrupt|pause|resume|permission\/[^/]+\/reply|question\/[^/]+\/(?:reply|reject))$/,
]
const METHOD_CONTROL_PATHS: ReadonlyArray<{ method: string; path: RegExp }> = [
  // Explicit-ID metadata resolution is part of prompt admission after a cache
  // miss. It is Tier 1 and must remain reachable when renderer SSE sockets fill.
  { method: "GET", path: /^\/global\/session\/ses_[^/]+$/ },
  { method: "PUT", path: /^\/session\/[^/]+\/goal$/ },
  { method: "DELETE", path: /^\/session\/[^/]+\/goal$/ },
  // Permission policy synchronization is part of prompt admission. Keep it on
  // the isolated urgent sidecar transport so a saturated renderer HTTP pool
  // cannot strand every prompt before it reaches the runtime.
  { method: "PUT", path: /^\/permission\/auto-accept$/ },
]

export function isLoopbackHttpOrigin(value: string) {
  try {
    const url = new URL(value)
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    )
  } catch {
    return false
  }
}

/** Routes required for explicit session admission or lifecycle control. */
export function isSidecarControlFetch(input: RequestInfo | URL, init?: RequestInit) {
  let url: URL
  let method: string
  try {
    url = new URL(input instanceof Request ? input.url : input.toString())
    method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
  } catch {
    return false
  }
  return (
    (method === "POST" && CONTROL_PATHS.some((path) => path.test(url.pathname))) ||
    METHOD_CONTROL_PATHS.some((control) => control.method === method && control.path.test(url.pathname))
  )
}

/** Runtime admission may await execution setup; durable V1 creation must not. */
export function sidecarControlLane(input: RequestInfo | URL, init?: RequestInit): "urgent" | "admission" | undefined {
  if (!isSidecarControlFetch(input, init)) return undefined
  const path = new URL(input instanceof Request ? input.url : input.toString()).pathname
  return /^\/api\/session$/.test(path) ||
    /\/(?:prompt|prompt_async)$/.test(path) || /\/goal(?:\/|$)/.test(path)
    ? "admission" : "urgent"
}
