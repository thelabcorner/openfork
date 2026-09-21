import type { ProviderResult } from "@/utils/limits-format"
import { ScopedKey, ServerScope, type ServerScope as ServerScopeValue } from "@/utils/server-scope"

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

function cacheKey(scope: ServerScopeValue) {
  return scope === ServerScope.local ? CACHE_KEY : ScopedKey.from(scope, CACHE_KEY)
}

function readCache(scope: ServerScopeValue): CacheEntry | undefined {
  if (typeof localStorage === "undefined") return undefined
  const key = cacheKey(scope)
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return undefined
    const entry = JSON.parse(raw) as CacheEntry
    if (entry.version !== VERSION) {
      localStorage.removeItem(key)
      return undefined
    }
    if (Date.now() - entry.timestamp > STALE_TTL_MS) {
      localStorage.removeItem(key)
      return undefined
    }
    return entry
  } catch {
    return undefined
  }
}

const pendingWrites = new Map<string, CacheEntry>()
let writeTimer: ReturnType<typeof setTimeout> | undefined

function scheduleWrite(key: string, entry: CacheEntry) {
  pendingWrites.set(key, entry)
  if (writeTimer !== undefined) return
  writeTimer = setTimeout(() => {
    writeTimer = undefined
    const writes = [...pendingWrites]
    pendingWrites.clear()
    for (const [target, toWrite] of writes) {
      try {
        localStorage.setItem(target, JSON.stringify(toWrite))
      } catch {}
    }
  }, 500)
  if (typeof (writeTimer as any).unref === "function") (writeTimer as any).unref()
}

export function loadLimitsCache(scope: ServerScopeValue): CacheEntry | undefined {
  const entry = readCache(scope)
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

export function saveLimitsCache(scope: ServerScopeValue, providers: CacheEntry["providers"], results: ProviderResult[]) {
  const entry: CacheEntry = {
    version: VERSION,
    timestamp: Date.now(),
    providers,
    results,
  }
  scheduleWrite(cacheKey(scope), entry)
}

export function clearLimitsCache(scope: ServerScopeValue) {
  if (typeof localStorage === "undefined") return
  const key = cacheKey(scope)
  try {
    localStorage.removeItem(key)
  } catch {}
  pendingWrites.delete(key)
  if (writeTimer !== undefined && pendingWrites.size === 0) {
    clearTimeout(writeTimer)
    writeTimer = undefined
  }
}

export type { CacheEntry }
