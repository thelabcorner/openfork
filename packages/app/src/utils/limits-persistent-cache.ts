import type { ProviderResult } from "@/utils/limits-format"

const CACHE_KEY = "opencode.limits.cache.v2"
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 min - matches backend TTL
const STALE_TTL_MS = 60 * 60 * 1000 // 1 hour - stale still shown instantly while revalidating
const VERSION = 2

type CacheEntry = {
  version: number
  timestamp: number
  providers: Array<{ providerId: string; providerName: string; configured: boolean }>
  results: ProviderResult[]
}

function readCache(): CacheEntry | undefined {
  if (typeof localStorage === "undefined") return undefined
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return undefined
    const entry = JSON.parse(raw) as CacheEntry
    if (entry.version !== VERSION) {
      localStorage.removeItem(CACHE_KEY)
      return undefined
    }
    if (Date.now() - entry.timestamp > STALE_TTL_MS) {
      localStorage.removeItem(CACHE_KEY)
      return undefined
    }
    return entry
  } catch {
    return undefined
  }
}

let pendingWrite: CacheEntry | undefined
let writeTimer: ReturnType<typeof setTimeout> | undefined

function scheduleWrite(entry: CacheEntry) {
  pendingWrite = entry
  if (writeTimer !== undefined) return
  writeTimer = setTimeout(() => {
    writeTimer = undefined
    if (!pendingWrite) return
    const toWrite = pendingWrite
    pendingWrite = undefined
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(toWrite))
    } catch {}
  }, 500)
  if (typeof (writeTimer as any).unref === "function") (writeTimer as any).unref()
}

export function loadLimitsCache(): CacheEntry | undefined {
  const entry = readCache()
  if (!entry) return undefined
  return entry
}

export function isCacheFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.timestamp < CACHE_TTL_MS
}

export function isCacheStale(entry: CacheEntry): boolean {
  const age = Date.now() - entry.timestamp
  return age >= CACHE_TTL_MS && age < STALE_TTL_MS
}

export function saveLimitsCache(providers: CacheEntry["providers"], results: ProviderResult[]) {
  const entry: CacheEntry = {
    version: VERSION,
    timestamp: Date.now(),
    providers,
    results,
  }
  scheduleWrite(entry)
}

export function clearLimitsCache() {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {}
  if (writeTimer !== undefined) {
    clearTimeout(writeTimer)
    writeTimer = undefined
  }
  pendingWrite = undefined
}

export type { CacheEntry }
