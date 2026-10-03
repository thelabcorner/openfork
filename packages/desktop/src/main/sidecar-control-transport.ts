import {
  isLoopbackHttpOrigin,
  isSidecarControlFetch,
  MAX_SIDE_CAR_CONTROL_REQUEST_BYTES,
  sidecarControlLane,
  type SidecarControlFetchInput,
} from "@opencode-ai/app/sidecar-control-request"

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const FORWARDED_HEADERS = new Set([
  "accept",
  "authorization",
  "content-type",
  "x-opencode-directory",
  "x-opencode-workspace",
])

export type SidecarControlFetchResult = {
  status: number
  statusText: string
  headers: Record<string, string>
  body?: string
}

async function readLimitedBody(response: Response, signal: AbortSignal) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError")
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error("Sidecar control response is too large")
      }
      chunks.push(item.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export function isLoopbackControlOrigin(value: string) {
  try {
    const url = new URL(value)
    return (
      isLoopbackHttpOrigin(value) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

export function validateSidecarControlFetch(input: SidecarControlFetchInput, sidecarURL: string) {
  if (!isLoopbackControlOrigin(sidecarURL)) throw new Error("Sidecar control transport requires the local sidecar")
  let target: URL
  let trusted: URL
  try {
    target = new URL(input.url)
    trusted = new URL(sidecarURL)
  } catch {
    throw new Error("Invalid sidecar control URL")
  }
  if (target.origin !== trusted.origin || target.username || target.password || target.hash)
    throw new Error("Sidecar control URL does not match the active sidecar")
  if (!isSidecarControlFetch(target, { method: input.method })) throw new Error("Route is not eligible for control transport")
  if (
    input.body !== undefined &&
    new TextEncoder().encode(input.body).byteLength > MAX_SIDE_CAR_CONTROL_REQUEST_BYTES
  )
    throw new Error("Sidecar control request is too large")

  const headers = new Headers()
  for (const [name, value] of Object.entries(input.headers)) {
    const key = name.toLowerCase()
    if (!FORWARDED_HEADERS.has(key)) throw new Error(`Header is not allowed on the sidecar control transport: ${key}`)
    if (typeof value !== "string" || value.length > 16_384) throw new Error("Invalid sidecar control header")
    if (key === "authorization" && !/^Basic [A-Za-z0-9+/=]+$/.test(value))
      throw new Error("Sidecar control authorization must use Basic credentials")
    if (key === "content-type" && !/^application\/json(?:\s*;.*)?$/i.test(value))
      throw new Error("Sidecar control requests must use JSON")
    headers.set(key, value)
  }
  return { target, headers }
}

export function createSidecarControlTransport(options: {
  sidecarURL: () => string | null
  fetch: (url: URL, init: RequestInit) => Promise<Response>
  fetchAdmission?: (url: URL, init: RequestInit) => Promise<Response>
}) {
  return async (input: SidecarControlFetchInput, signal: AbortSignal): Promise<SidecarControlFetchResult> => {
    const sidecarURL = options.sidecarURL()
    if (!sidecarURL) throw new Error("The active sidecar is not ready")
    const { target, headers } = validateSidecarControlFetch(input, sidecarURL)
    const fetch = sidecarControlLane(target, { method: input.method }) === "admission"
      ? options.fetchAdmission ?? options.fetch : options.fetch
    const response = await fetch(target, {
      method: input.method,
      headers,
      body: input.body,
      signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    })
    const body = await readLimitedBody(response, signal)
    const resultHeaders: Record<string, string> = {}
    const contentType = response.headers.get("content-type")
    if (contentType) resultHeaders["content-type"] = contentType
    return {
      status: response.status,
      statusText: response.statusText,
      headers: resultHeaders,
      ...(body ? { body } : {}),
    }
  }
}
