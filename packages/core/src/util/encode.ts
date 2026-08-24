const base64Cache = new Map<string, string>()
const BASE64_CACHE_MAX = 2000
export function base64Encode(value: string) {
  const cached = base64Cache.get(value)
  if (cached !== undefined) {
    // LRU bump
    base64Cache.delete(value)
    base64Cache.set(value, cached)
    return cached
  }
  const bytes = new TextEncoder().encode(value)
  const chunk = 0x8000
  let binary = ""
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  const out = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
  if (base64Cache.size >= BASE64_CACHE_MAX) {
    const oldest = base64Cache.keys().next().value as string | undefined
    if (oldest !== undefined) base64Cache.delete(oldest)
  }
  base64Cache.set(value, out)
  return out
}

export function base64Decode(value: string) {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"))
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export async function hash(content: string, algorithm = "SHA-256"): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest(algorithm, data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
  return hashHex
}

export function checksum(content: string): string | undefined {
  if (!content) return undefined
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function sampledChecksum(content: string, limit = 500_000): string | undefined {
  if (!content) return undefined
  if (content.length <= limit) return checksum(content)

  const size = 4096
  const points = [
    0,
    Math.floor(content.length * 0.25),
    Math.floor(content.length * 0.5),
    Math.floor(content.length * 0.75),
    content.length - size,
  ]
  const hashes = points
    .map((point) => {
      const start = Math.max(0, Math.min(content.length - size, point - Math.floor(size / 2)))
      return checksum(content.slice(start, start + size)) ?? ""
    })
    .join(":")
  return `${content.length}:${hashes}`
}
