import { normalizePairCode, normalizeServerUrl, validPairCode } from "./pairing-input"

export type PairingPayload = { code: string; serverUrl?: string }

/** QR/deep-link secrets must be exact, not a prefix truncated from garbage. */
export function parseLinkPairCode(value: string | null): string | undefined {
  if (!value) return
  const code = value.trim().toUpperCase()
  return code.length === 6 && validPairCode(code) ? code : undefined
}

/**
 * A desktop-generated URL must explicitly identify the API endpoint. Its
 * navigation origin is the PUBLIC PWA, and is never an implicit API fallback.
 */
export function parsePairingPayload(raw: string): PairingPayload | undefined {
  const input = raw.trim()
  try {
    const url = new URL(input)
    if (url.protocol !== "https:" && url.protocol !== "http:") return
    if (url.username || url.password) return
    const rawCode = new URLSearchParams(url.hash.replace(/^#/, "")).get("pair") ?? url.searchParams.get("pair")
    if (!rawCode) return
    const code = parseLinkPairCode(rawCode)
    if (!code) return
    const target = url.searchParams.get("server")
    if (!target) return

    const serverUrl = normalizeServerUrl(target)
    if (new URL(serverUrl).origin === url.origin) return
    return { code, serverUrl }
  } catch {
    // The camera can also accept a short, code-only QR, but not an
    // incomplete PWA URL or a malformed API target.
    const code = normalizePairCode(input)
    if (validPairCode(code) && /^[A-Z0-9]{6}$/i.test(input)) return { code }
    return
  }
}
