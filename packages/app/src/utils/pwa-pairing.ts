import { authTokenFromCredentials } from "@/utils/server"

// PWA device-pairing claim flow (docs/pwa-mobile/04 §4, task p3).
//
// Boot path: entry-pwa reads location.hash for #pair=<code>, claims a device
// token via plain fetch BEFORE the SDK boots (the code must never reach the
// server SDK, referrers, or logs as a query param — it travels in the
// fragment, which browsers never send upstream), stores the token durably,
// strips the hash, then boots AppInterface with the token as Basic
// credentials (username "device", password <token>) — reusing the existing
// ServerConnection.Http shape unchanged.

export const DEVICE_TOKEN_STORAGE_KEY = "opencode.pwa.dat:deviceToken"

/** Username for device-token Basic auth; accepted by the server pairing middleware. */
export const DEVICE_AUTH_USERNAME = "device"

export const PAIR_CODE_LENGTH = 6

/** Server-issued charset (core/device.ts): 32 symbols, no 0/1/I/O. */
export const PAIR_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

/**
 * Extract the pairing code from a location.hash fragment.
 * Tolerates additional fragment params (`#x=1&pair=K7M2XQ`) since the QR URL
 * shape is owned by the desktop pair dialog. Pure: returns undefined for
 * absent/malformed fragments.
 */
export function parsePairCode(hash: string) {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash
  const pattern = new RegExp(`(?:^|&)pair=([A-Za-z0-9]{${PAIR_CODE_LENGTH}})(?:&|$)`)
  return pattern.exec(fragment)?.[1]?.toUpperCase()
}

/**
 * Pure: remove the pair param from a raw fragment string.
 * Returns undefined when there is no pair param (leave the URL alone),
 * otherwise the remaining params ("" when the fragment becomes empty).
 */
export function stripPairParam(fragment: string) {
  const params = new URLSearchParams(fragment.startsWith("#") ? fragment.slice(1) : fragment)
  if (!params.has("pair")) return undefined
  params.delete("pair")
  return params.toString()
}

/** Strip the #pair= param from the fragment without creating a history entry. */
export function stripPairHash() {
  const rest = stripPairParam(location.hash)
  if (rest === undefined) return
  history.replaceState(null, "", location.pathname + location.search + (rest ? `#${rest}` : ""))
}

export function readStoredDeviceToken() {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

export function storeDeviceToken(token: string) {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, token)
  } catch {
    return
  }
}

export function clearDeviceToken() {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.removeItem(DEVICE_TOKEN_STORAGE_KEY)
  } catch {
    return
  }
}

/** Basic credentials carrying the device token; spreads into ServerConnection.HttpBase. */
export function deviceCredentials(token: string) {
  return { username: DEVICE_AUTH_USERNAME, password: token }
}

export type ClaimResult = { ok: true; token: string } | { ok: false; status?: number }

/**
 * Exchange a pairing code for a device token via plain fetch (pre-SDK-boot).
 * Deliberately not typed against the generated clients: this runs before any
 * client exists and must stay dependency-free.
 */
export async function claimDeviceToken(baseUrl: string, code: string): Promise<ClaimResult> {
  let response: Response
  try {
    response = await fetch(new URL("/pair/claim", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    })
  } catch {
    return { ok: false }
  }
  if (!response.ok) return { ok: false, status: response.status }
  const data = await response.json().catch(() => undefined)
  const token =
    typeof data?.token === "string" ? data.token : typeof data?.deviceToken === "string" ? data.deviceToken : undefined
  if (!token) return { ok: false, status: response.status }
  return { ok: true, token }
}

export type TokenVerdict = "valid" | "invalid" | "unknown"

/**
 * Probe whether a stored device token is still accepted. Only an explicit
 * 401/403 counts as invalid — network failures and server errors must NOT
 * clear the stored token (offline boots stay optimistic).
 */
export async function verifyDeviceToken(baseUrl: string, token: string): Promise<TokenVerdict> {
  let response: Response
  try {
    response = await fetch(new URL("/global/health", baseUrl), {
      headers: { Authorization: `Basic ${authTokenFromCredentials(deviceCredentials(token))}` },
    })
  } catch {
    return "unknown"
  }
  if (response.status === 401 || response.status === 403) return "invalid"
  if (response.ok) return "valid"
  return "unknown"
}
