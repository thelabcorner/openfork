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
  { method: "PUT", path: /^\/session\/[^/]+\/goal$/ },
  { method: "DELETE", path: /^\/session\/[^/]+\/goal$/ },
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

/** Routes whose admission or lifecycle response changes live session control. */
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
