import { Effect, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { loadPersistentQuotaEntry, savePersistentQuotaEntry } from "../persistent-cache"

/**
 * Bounded GET-JSON seam for provider account endpoints. Adapters receive a
 * discriminated outcome instead of exceptions so each can fold failures into
 * its result envelope the way OpenChamber's per-provider try/catch did.
 */

const REQUEST_TIMEOUT = "5 seconds"

export type FetchOutcome =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly error: "status"; readonly status: number; readonly body?: string; readonly retryAfterMs?: number }
  | { readonly ok: false; readonly error: "network"; readonly message: string }
  | { readonly ok: false; readonly error: "parse"; readonly message: string }
  | { readonly ok: false; readonly error: "timeout" }

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const parsed = Date.parse(trimmed)
  if (Number.isFinite(parsed)) return Math.max(0, parsed - Date.now())
  return undefined
}

function getHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") return null
  const h = headers as Record<string, unknown>
  if (typeof (h as { get?: unknown }).get === "function") {
    try {
      const v = (h as { get: (k: string) => string | null }).get(name)
      if (v) return v
      return (h as { get: (k: string) => string | null }).get(name.toLowerCase()) ?? null
    } catch {
      return null
    }
  }
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lower && typeof v === "string") return v
    if (k.toLowerCase() === lower && Array.isArray(v) && typeof v[0] === "string") return v[0] as string
  }
  return null
}

export function outcomeError(outcome: Extract<FetchOutcome, { ok: false }>): string {
  if (outcome.error === "status") {
    const base = outcome.status === 429
      ? "Rate limited (429) — Anthropic is throttling usage checks"
      : `API error: ${outcome.status}`
    const body = outcome.body?.trim()
    const useful = body && body.length > 0 && body !== "null" && !body.startsWith("{")
    return useful ? `${base} (${body})` : base
  }
  if (outcome.error === "timeout") return "Request timed out"
  if (outcome.error === "parse") return `Invalid response: ${outcome.message}`
  return outcome.message
}

const CACHE_TTL_MS = 300_000
const COOLDOWN_DEFAULT_MS = 300_000
const COOLDOWN_MAX_MS = 3_600_000

/** Epoch ms for "refresh now" — a provider with no cache is always re-readable. */
export const NEXT_REFRESH_NOW = 0

/**
 * Shared in-memory cache + 429-cooldown for a single provider adapter
 * instance. Every provider hits its upstream usage endpoint on each
 * `quota.get()` call from the frontend (mount, window focus, manual
 * refresh) — without this, a provider that doesn't special-case 429 keeps
 * getting hammered every ~30s even while it's actively throttling us,
 * extending the block instead of backing off. Claude already had this
 * pattern hand-rolled; this generalizes it so every adapter gets the same
 * protection for free.
 */
export function createQuotaCache<T>(key: string, options?: { ttlMs?: number; cooldownDefaultMs?: number; cooldownMaxMs?: number; persistentKey?: string }) {
  const ttlMs = options?.ttlMs ?? CACHE_TTL_MS
  const cooldownDefaultMs = options?.cooldownDefaultMs ?? COOLDOWN_DEFAULT_MS
  const cooldownMaxMs = options?.cooldownMaxMs ?? COOLDOWN_MAX_MS
  const persistentKey = options?.persistentKey
  let cached: { key: string; fetchedAt: number; result: T } | undefined
  let cooldownUntil = 0
  // Hydrate from persistent file on first creation (survives restarts, instant stale)
  if (persistentKey) {
    try {
      const persisted = loadPersistentQuotaEntry<T>(persistentKey)
      if (persisted) {
        cached = { key, fetchedAt: persisted.fetchedAt, result: persisted.result }
        cooldownUntil = persisted.cooldownUntil
      }
    } catch {}
  }
  const persist = (fetchedAt: number, result: T, cdUntil: number) => {
    if (!persistentKey) return
    try {
      savePersistentQuotaEntry(persistentKey, fetchedAt, result, cdUntil)
    } catch {}
  }
  return {
    fresh(currentKey = key): T | undefined {
      if (cached && cached.key === currentKey && Date.now() - cached.fetchedAt < ttlMs) return cached.result
      // Persistent stale is still served as fresh if within TTL - already above
      return undefined
    },
    isCoolingDown(): boolean {
      return Date.now() < cooldownUntil
    },
    cachedResult(): T | undefined {
      return cached?.result
    },
    /** Stale result regardless of TTL - for stale-while-revalidate instant paint */
    staleResult(): T | undefined {
      return cached?.result
    },
    /** Whether we have any cached entry (fresh or stale) */
    hasCache(): boolean {
      return !!cached
    },
    /**
     * Epoch ms before which a re-read is guaranteed to be served from cache,
     * so calling `quota.get()` again would repaint identical numbers. After a
     * 429 this is the end of the cooldown (up to `cooldownMaxMs`), which can
     * exceed the normal TTL — that longer backoff is exactly what the UI
     * needs to show. No cache entry means "refresh is useful right now".
     */
    nextRefreshAt(): number {
      if (!cached) return 0
      return Math.max(cached.fetchedAt + ttlMs, cooldownUntil)
    },
    reset(): void {
      cached = undefined
      cooldownUntil = 0
    },
    store(result: T, currentKey = key): void {
      const now = Date.now()
      cached = { key: currentKey, fetchedAt: now, result }
      cooldownUntil = 0
      persist(now, result, 0)
    },
    /** Cache the error result and back off for `retryAfterMs` (capped), or a default window. */
    coolDown(result: T, retryAfterMs: number | undefined, currentKey = key): void {
      const capped = retryAfterMs !== undefined ? Math.min(Math.max(retryAfterMs, 1000), cooldownMaxMs) : cooldownDefaultMs
      const now = Date.now()
      cooldownUntil = now + capped
      cached = { key: currentKey, fetchedAt: now, result }
      persist(now, result, cooldownUntil)
    },
  }
}

export const fetchJson = (
  http: HttpClient.HttpClient,
  url: string,
  key: string,
  headers?: Record<string, string>,
): Effect.Effect<FetchOutcome> =>
  Effect.catch(
    Effect.gen(function* () {
      const request = HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeaders({ authorization: `Bearer ${key}`, ...headers }),
      )
      const raced = yield* Effect.timeoutOption(http.execute(request), REQUEST_TIMEOUT)
      if (Option.isNone(raced)) return { ok: false, error: "timeout" } satisfies FetchOutcome
      const response = raced.value
      if (response.status < 200 || response.status >= 300) {
        // best-effort to capture a snippet of the error body for 429s etc.
        let bodySnippet: string | undefined
        try {
          const txt = (yield* response.text).trim()
          if (txt && txt !== "null" && txt.length > 0) {
            bodySnippet = txt.slice(0, 200)
          }
        } catch {}
        const retryAfterMs =
          response.status === 429 ? parseRetryAfterMs(getHeader((response as unknown as { headers: unknown }).headers, "retry-after")) : undefined
        return {
          ok: false,
          error: "status",
          status: response.status,
          ...(bodySnippet ? { body: bodySnippet } : {}),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        } as const
      }
      return yield* Effect.map(response.json, (body): FetchOutcome => ({ ok: true, body }))
    }),
    (error) => Effect.succeed({ ok: false, error: "network", message: error.message }),
  )
