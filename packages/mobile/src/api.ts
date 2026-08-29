import { createOpencodeClient, type Message, type OpencodeClient, type Part } from "@opencode-ai/sdk/v2/client"

export const SERVER_URL_KEY = "opencode.mobile.serverUrl"
export const DEVICE_TOKEN_KEY = "opencode.mobile.deviceToken"
export const DEVICE_ID_KEY = "opencode.mobile.deviceID"

export type MessageBundle = {
  info: Message
  parts: Part[]
}

export type LaunchConfig = {
  serverUrl?: string
  pairCode?: string
}

export function selectLaunchServer(input: {
  requested?: string
  fallback?: string
  pairCode?: string
  storedToken?: string
  storedServer?: string
}) {
  if (!input.pairCode && input.storedToken && input.storedServer) return input.storedServer
  return input.requested ?? input.fallback
}

export function readLaunchConfig(): LaunchConfig {
  const params = new URLSearchParams(location.search)
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""))
  const pairCode = (fragment.get("pair") ?? params.get("pair"))?.trim().toUpperCase()
  if (pairCode) {
    // Strip the single-use code from the address bar (hash and query).
    params.delete("pair")
    fragment.delete("pair")
    const search = params.toString()
    history.replaceState(null, "", `${location.pathname}${search ? `?${search}` : ""}`)
  }

  // In dev the PWA is served by vite on 0.0.0.0:3301 and the phone loads it
  // from the LAN IP. Same-origin via the vite proxy is the only reachable
  // path — stale localStorage (old 127.0.0.1 / LAN IP) would poison it, and
  // the IP can change between dev sessions.
  // The vite proxy target itself is driven by VITE_OPENCODE_SERVER_URL /
  // OPENCODE_DEV_PROXY_TARGET (vite.config.ts) so the browser must stay on
  // location.origin (the vite origin) to stay same-origin through the proxy.
  // An explicit ?server= param (LAN URL from desktop's runtime context) still
  // wins when present — e.g. desktop QR pairing in dev.
  if (import.meta.env.DEV) {
    const qsServer = params.get("server")?.trim()
    const serverUrl = qsServer || location.origin
    return { serverUrl, pairCode }
  }

  const storedServer = readStorage(SERVER_URL_KEY)
  const explicitServerUrl = selectLaunchServer({
    requested: params.get("server") ?? undefined,
    fallback: storedServer ?? import.meta.env.VITE_OPENCODE_SERVER_URL,
    pairCode,
    storedToken: readStorage(DEVICE_TOKEN_KEY),
    storedServer,
  })
  return {
    // Server-minted launch URLs point at the API server itself, so a pair
    // launch with no explicit server defaults to this page's origin. Never
    // applied to normal launches.
    serverUrl: pairCode && !explicitServerUrl ? location.origin : explicitServerUrl,
    pairCode,
  }
}

export function normalizeServerUrl(value: string) {
  const url = new URL(value.trim())
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Server URL must use HTTP or HTTPS")
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (!import.meta.env.DEV && url.protocol !== "https:" && !local) throw new Error("Remote servers must use HTTPS")
  url.username = ""
  url.password = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}

export function readStorage(key: string) {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

export function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage is an optimization; the active connection remains usable.
  }
}

export function clearStorage(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // Ignore storage failures.
  }
}

function authorization(token?: string) {
  if (!token) return undefined
  return `Basic ${btoa(`device:${token}`)}`
}

export function createClient(serverUrl: string, token?: string): OpencodeClient {
  return createOpencodeClient({
    baseUrl: serverUrl,
    headers: {
      ...(authorization(token) ? { Authorization: authorization(token)! } : {}),
    },
  })
}

export async function claimPair(serverUrl: string, code: string) {
  const response = await createClient(serverUrl).pair.claim({ code, name: "OpenCode Mobile" }, { throwOnError: true })
  if (!response.data) throw new Error("The server did not return a device token")
  return { token: response.data.token, deviceID: response.data.device.id }
}

type PairClaimErrorBody = {
  name?: unknown
  data?: { message?: unknown; reason?: unknown; retryAfterMs?: unknown }
}

// With throwOnError the SDK raises an Error whose parsed API error body (and
// HTTP status) live under `.cause` — map the pair endpoint shapes to text.
export function pairClaimErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Pair claim failed"
  const cause = error.cause as { body?: PairClaimErrorBody; status?: number } | undefined
  const body = cause?.body
  if (body?.name === "ClaimRateLimitedError" || cause?.status === 429) {
    const seconds = Math.max(1, Math.ceil((typeof body?.data?.retryAfterMs === "number" ? body.data.retryAfterMs : 0) / 1000))
    return `Too many attempts — try again in ${seconds}s`
  }
  if (body?.name === "PairCodeError") {
    if (body.data?.reason === "expired") return "This code has expired"
    if (body.data?.reason === "invalid") return "Unknown or already used code"
  }
  if (typeof body?.data?.message === "string") return body.data.message
  return error.message || "Pair claim failed"
}

export async function openEvents(
  client: OpencodeClient,
  signal: AbortSignal,
  channel: "current" | "compatibility",
  onEvent: (event: unknown) => void,
) {
  const options = { signal, sseMaxRetryAttempts: 0 }
  // Current sessions publish native events through /api/event. Desktop can
  // still run compatibility sessions, whose cross-directory feed is
  // /global/event. Mobile displays both, so it must consume both feeds.
  const response = channel === "current"
    ? await client.v2.event.subscribe(options)
    : await client.global.event(options)
  for await (const event of response.stream) {
    if (signal.aborted) return
    onEvent(channel === "compatibility" ? (event as any)?.payload ?? event : event)
  }
}
