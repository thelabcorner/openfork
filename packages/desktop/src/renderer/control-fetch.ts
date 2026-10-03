import {
  isLoopbackHttpOrigin,
  isSidecarControlFetch,
  type SidecarControlFetchInput,
} from "@opencode-ai/app/sidecar-control-request"
import type { ServerReadyData } from "../preload/types"

const abortError = () => new DOMException("The operation was aborted", "AbortError")

export function createDesktopFetch(options: {
  fetch: typeof globalThis.fetch
  awaitInitialization: () => Promise<ServerReadyData>
  dispatch: (requestID: string, input: SidecarControlFetchInput) => Promise<{
    status: number
    statusText: string
    headers: Record<string, string>
    body?: string
  }>
  cancel: (requestID: string) => void
}) {
  let initialization: Promise<ServerReadyData> | undefined
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isSidecarControlFetch(input, init)) return options.fetch(input, init)

    const request = new Request(input, init)
    const signal = request.signal
    if (signal.aborted) throw abortError()

    // Only the exact active app sidecar origin can use the isolated network
    // session. Remote server connections keep the normal renderer fetch path.
    initialization ??= options.awaitInitialization()
    let sidecar: ServerReadyData
    try {
      sidecar = await initialization
    } catch {
      return options.fetch(input, init)
    }
    if (!sidecar || typeof sidecar.url !== "string") return options.fetch(input, init)
    let sidecarURL: URL
    try {
      sidecarURL = new URL(sidecar.url)
    } catch {
      return options.fetch(input, init)
    }
    if (!isLoopbackHttpOrigin(sidecar.url) || new URL(request.url).origin !== sidecarURL.origin)
      return options.fetch(input, init)
    if (signal.aborted) throw abortError()

    const requestID = crypto.randomUUID()
    const forwarded: Record<string, string> = {}
    request.headers.forEach((value, key) => (forwarded[key] = value))
    const control: SidecarControlFetchInput = {
      url: request.url,
      method: request.method,
      headers: forwarded,
      ...(request.body === null ? {} : { body: await request.clone().text() }),
    }
    if (signal.aborted) throw abortError()

    let active = true
    const onAbort = () => {
      if (!active) return
      options.cancel(requestID)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    try {
      const result = await options.dispatch(requestID, control)
      if (signal.aborted) throw abortError()
      return new Response(result.body, {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
      })
    } finally {
      active = false
      signal.removeEventListener("abort", onAbort)
    }
  }
}
