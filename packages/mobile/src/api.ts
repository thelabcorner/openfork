import { createOpencodeClient, type Message, type OpencodeClient, type Part } from "@opencode-ai/sdk/v2/client"
import { IDENTITY_PATH } from "../dev/constants"

export const SERVER_URL_KEY = "opencode.mobile.serverUrl"
export const DEVICE_TOKEN_KEY = "opencode.mobile.deviceToken"
export const DEVICE_ID_KEY = "opencode.mobile.deviceID"
export const INSTANCE_ID_KEY = "opencode.mobile.instanceID"

export type InstanceIdentity = {
  instanceID: string
  processID?: number
  startedAt?: string
  version?: string
  client?: string
}

/**
 * Unauthenticated, and answered before any credential is sent — it exists so a
 * client can find out *which* opencode process it reached. A URL and a
 * listening port say nothing on a machine running several of them, which is
 * how this app used to end up driving an unrelated instance's sessions.
 *
 * Servers older than this endpoint return the SPA's HTML from the catch-all
 * route, so a non-JSON body means "too old", not "no server".
 */
export async function fetchIdentity(serverUrl: string, signal?: AbortSignal): Promise<InstanceIdentity | undefined> {
  try {
    const response = await fetch(new URL(IDENTITY_PATH, `${serverUrl.replace(/\/$/, "")}/`), {
      headers: { accept: "application/json" },
      signal,
    })
    if (!response.ok) return undefined
    if (!(response.headers.get("content-type") ?? "").includes("json")) return undefined
    const body = (await response.json()) as InstanceIdentity
    return typeof body?.instanceID === "string" && body.instanceID ? body : undefined
  } catch {
    return undefined
  }
}

/**
 * Decides what a freshly observed identity means for a stored pin.
 *
 * "changed" is not an error — restarting the desktop legitimately mints a new
 * instance — but cached sessions, messages and runtimes belong to the old one
 * and must be dropped rather than silently blended into the new instance's
 * state.
 */
export function compareInstance(input: { pinned?: string; observed?: string }) {
  if (!input.observed) return { state: "unknown" as const }
  if (!input.pinned) return { state: "adopted" as const, instanceID: input.observed }
  if (input.pinned === input.observed) return { state: "same" as const, instanceID: input.observed }
  return { state: "changed" as const, instanceID: input.observed, previous: input.pinned }
}

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

  let storedServer = readStorage(SERVER_URL_KEY)
  // Migration: earlier builds stored the PWA origin itself (e.g.
  // https://opencode.thedabcorner.site) as the API URL. That origin
  // is a static Pages deployment and will always 500 on /pair/claim.
  // If the baked VITE_OPENCODE_SERVER_URL points elsewhere, ignore the
  // stale value so the baked URL (or ?server= param) can take over.
  const baked = (import.meta.env.VITE_OPENCODE_SERVER_URL as string | undefined)?.trim()
  try {
    if (
      storedServer &&
      baked &&
      normalizeServerUrl(storedServer) === normalizeServerUrl(location.origin) &&
      normalizeServerUrl(baked) !== normalizeServerUrl(location.origin)
    ) {
      try {
        localStorage.removeItem(SERVER_URL_KEY)
      } catch {}
      storedServer = undefined
    }
  } catch {
    // Invalid stored/baked URL — fall through to normal selection.
  }
  const explicitServerUrl = selectLaunchServer({
    requested: params.get("server") ?? undefined,
    fallback: storedServer ?? baked,
    pairCode,
    storedToken: readStorage(DEVICE_TOKEN_KEY),
    storedServer,
  })
  return {
    // In production the static PWA origin is never the API origin
    // (see docs/plans/pwa-mobile/08-separate-origin.md). A pairing
    // link from the desktop always carries ?server=, and manual code
    // entry must use the baked VITE_OPENCODE_SERVER_URL or the
    // previously stored value. Returning undefined here surfaces
    // “No server URL set” instead of silently POSTing to the static
    // host and getting a 500.
    serverUrl: explicitServerUrl,
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

/**
 * No instance pin here on purpose. `x-opencode-expect-instance` names a single
 * desktop *launch*, and this client is long-lived: pinning it meant every
 * request started failing with 409 as soon as the desktop restarted, so the
 * session list would render and then refuse to open anything.
 *
 * The pin is applied by whoever can keep it fresh — `dev/proxy.ts` re-resolves
 * and re-verifies per request — not by a client that cannot notice it went
 * stale. See INSTANCE_EXPECT_HEADER in dev/constants.ts.
 */
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
    const seconds = Math.max(
      1,
      Math.ceil((typeof body?.data?.retryAfterMs === "number" ? body.data.retryAfterMs : 0) / 1000),
    )
    return `Too many attempts — try again in ${seconds}s`
  }
  if (body?.name === "PairCodeError") {
    if (body.data?.reason === "expired") return "This code has expired"
    if (body.data?.reason === "invalid") return "Unknown or already used code"
  }
  if (typeof body?.data?.message === "string") return body.data.message
  // The static PWA host (e.g. opencode.thedabcorner.site) has no /pair/claim.
  // When the PWA posts there it gets a 500 with an empty body from Cloudflare
  // Pages. Surface the API origin in that case so the user can tell it's the
  // wrong instance and fix the server URL.
  const raw = error.message || ""
  if (cause?.status === 500 && (!body || Object.keys(body as object).length === 0)) {
    return raw.includes("/pair/claim")
      ? `${raw} — the API at this address is not an opencode server. Check the Server URL in Advanced and make sure the tunnel (OPENCODE_PUBLIC_URL) is running.`
      : raw
  }
  if (raw.includes("Failed to fetch") || raw.includes("NetworkError") || raw.includes("Load failed")) {
    return `${raw} — could not reach the API. Check the Server URL, tunnel, and that the server allows this PWA origin via --cors.`
  }
  return raw || "Pair claim failed"
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
  const response = channel === "current" ? await client.v2.event.subscribe(options) : await client.global.event(options)
  for await (const event of response.stream) {
    if (signal.aborted) return
    onEvent(channel === "compatibility" ? ((event as any)?.payload ?? event) : event)
  }
}
