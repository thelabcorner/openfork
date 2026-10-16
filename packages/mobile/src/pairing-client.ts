import { parseNetworkIdentityProjection, sameNetworkIdentity, type NetworkIdentity } from "./network-identity"

export type PairingFetch = (url: URL, init?: RequestInit) => Promise<Response>

type PairResponse = { token?: unknown; deviceToken?: unknown; device?: { id?: unknown } }
type PairErrorResponse = PairResponse & { data?: { message?: string; reason?: string; retryAfterMs?: number } }

// Bound both response headers AND streamed JSON body. A broken tunnel must not
// leave an installed PWA indefinitely in the Pairing/Verifying spinner.
const AUTH_REQUEST_TIMEOUT_MS = 12_000

async function boundedRequest<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException("Request aborted", "AbortError")
  const controller = new AbortController()
  let rejectCancel!: (reason: Error) => void
  const canceled = new Promise<never>((_, reject) => { rejectCancel = reject })
  const abort = () => {
    controller.abort()
    rejectCancel(new DOMException("Request aborted", "AbortError"))
  }
  signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => {
    controller.abort()
    rejectCancel(new Error("OpenFork authentication request timed out"))
  }, AUTH_REQUEST_TIMEOUT_MS)
  try {
    if (controller.signal.aborted) throw new DOMException("Request aborted", "AbortError")
    // Some fetch shims ignore AbortSignal. Race the deadline independently so
    // a hung transport cannot permanently retain the pairing spinner.
    return await Promise.race([run(controller.signal), canceled])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

/**
 * A pairing code is a bearer secret. Never send it to a destination that has
 * not first supplied a parseable public OpenFork Network identity. Checking
 * again after the claim closes a proxy/target-swap window in the ceremony.
 *
 * The code in the desktop QR authenticates the ceremony; TOFU identity pinning
 * protects future device-token use from silent endpoint replacement.
 */
export async function probeNetworkIdentity(
  serverUrl: string,
  request: PairingFetch = fetch,
  signal?: AbortSignal,
): Promise<NetworkIdentity | undefined> {
  try {
    return await boundedRequest(async (boundedSignal) => {
      const response = await request(new URL("/instance/identity", `${serverUrl}/`), {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: boundedSignal,
      })
      if (!response.ok) return
      return parseNetworkIdentityProjection(await response.json())
    }, signal)
  } catch {
    return
  }
}

export async function claimPair(serverUrl: string, code: string, request: PairingFetch = fetch, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Pairing cancelled", "AbortError")
  const before = await probeNetworkIdentity(serverUrl, request, signal)
  if (signal?.aborted) throw new DOMException("Pairing cancelled", "AbortError")
  if (!before) throw new Error("OpenFork Network identity is unavailable. Pairing was not attempted.")

  const { response, body } = await boundedRequest(async (boundedSignal) => {
    const response = await request(new URL("/pair/claim", `${serverUrl}/`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "OpenFork Mobile" }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: boundedSignal,
    })
    const body = (await response.json().catch(() => ({}))) as PairErrorResponse
    return { response, body }
  }, signal)
  if (!response.ok) {
    if (response.status === 429) {
      const retryMs = body.data?.retryAfterMs
      const seconds = typeof retryMs === "number" && Number.isFinite(retryMs)
        ? Math.max(1, Math.ceil(Math.min(Math.max(0, retryMs), 3_600_000) / 1000)) : 1
      throw new Error(`Too many attempts — try again in ${seconds}s`)
    }
    if (body.data?.reason === "expired") throw new Error("This pairing code has expired")
    if (body.data?.reason === "invalid") throw new Error("Unknown or already used pairing code")
    throw new Error(body.data?.message || `Pairing failed (${response.status})`)
  }

  const token = typeof body.token === "string" ? body.token : typeof body.deviceToken === "string" ? body.deviceToken : undefined
  // Never allow a malformed server response to become an Authorization header.
  if (!token || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token))
    throw new Error("The server did not return a valid device token")

  const after = await probeNetworkIdentity(serverUrl, request, signal)
  if (signal?.aborted) throw new DOMException("Pairing cancelled", "AbortError")
  if (!after || !sameNetworkIdentity(before, after)) {
    throw new Error("OpenFork Network identity changed or became unavailable during pairing. The device token was discarded.")
  }
  const deviceID = typeof body.device?.id === "string" ? body.device.id : undefined
  return { token, deviceID, networkIdentity: after }
}

export async function credentialVerdict(
  serverUrl: string,
  token?: string,
  request: PairingFetch = fetch,
  signal?: AbortSignal,
): Promise<"valid" | "invalid" | "unknown"> {
  try {
    return await boundedRequest(async (boundedSignal) => {
      const response = await request(new URL("/global/health", `${serverUrl}/`), {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: boundedSignal,
      })
      if (response.status === 401 || response.status === 403) return "invalid"
      return response.ok ? "valid" : "unknown"
    }, signal)
  } catch {
    // An offline tunnel is not evidence of token revocation.
    return "unknown"
  }
}

/** Legacy, unpinned credentials must never cross the network. */
export function canRestoreDeviceToken(token: string | undefined, identity: NetworkIdentity | undefined): boolean {
  return !token || !!identity
}
