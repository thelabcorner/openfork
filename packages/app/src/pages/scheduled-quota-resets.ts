import type { QuotaResetsResponse } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"

export type QuotaResetAgenda = QuotaResetsResponse
export type QuotaResetOccurrence = QuotaResetAgenda["occurrences"][number]
export type QuotaResetFailure = QuotaResetAgenda["failures"][number]

type Window = { readonly from: number; readonly to: number }
type CachedAgenda = { readonly at: number; readonly value: QuotaResetAgenda }

const CACHE_TTL_MS = 30_000
const MAX_CACHE_ENTRIES = 6

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Page-local transport/cache for the Tier-0 quota reset projection.
 *
 * Quota/provider/account semantics stay server-owned. This controller only
 * deduplicates one bounded calendar request per visible range, preserves the
 * last good payload while refreshing, and never polls in the background.
 */
export function createScheduledQuotaResets() {
  const serverSDK = useServerSDK()
  const [state, setState] = createStore({
    agenda: undefined as QuotaResetAgenda | undefined,
    key: undefined as string | undefined,
    loadedAt: 0,
    loading: false,
    error: undefined as string | undefined,
  })

  const cache = new Map<string, CachedAgenda>()
  const inflight = new Map<string, Promise<QuotaResetAgenda>>()

  const remember = (key: string, value: QuotaResetAgenda, loadedAt: number) => {
    cache.delete(key)
    cache.set(key, { at: loadedAt, value })
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }
  let active: Window | undefined

  const scope = () => serverSDK().scope
  const keyFor = (input: Window) => `${scope()}:${input.from}:${input.to}`

  const commit = (key: string, value: QuotaResetAgenda, loadedAt: number) => {
    if (state.key !== key) return
    setState("agenda", value)
    setState("loadedAt", loadedAt)
    setState("error", undefined)
  }

  const load = async (input: Window, options?: { force?: boolean }) => {
    active = input
    const key = keyFor(input)
    setState("key", key)
    setState("error", undefined)

    const cached = cache.get(key)
    if (!options?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      setState("loading", false)
      commit(key, cached.value, cached.at)
      return cached.value
    }

    const pending = inflight.get(key)
    if (pending) {
      setState("loading", true)
      return pending
    }

    setState("loading", true)
    const request = serverSDK()
      .client.quota.resets(
        { from: String(input.from), to: String(input.to) },
        { throwOnError: true },
      )
      .then((response) => {
        if (!response.data) throw new Error("Quota reset agenda returned no data")
        const loadedAt = Date.now()
        const value = response.data as QuotaResetAgenda
        remember(key, value, loadedAt)
        commit(key, value, loadedAt)
        return value
      })
      .catch((error) => {
        if (state.key === key) setState("error", messageOf(error))
        throw error
      })
      .finally(() => {
        inflight.delete(key)
        if (state.key === key) setState("loading", false)
      })

    inflight.set(key, request)
    return request
  }

  const refresh = () => {
    if (!active) return Promise.resolve(undefined)
    return load(active, { force: true })
  }

  const refreshIfStale = () => {
    if (!active || state.loading) return
    if (state.loadedAt > 0 && Date.now() - state.loadedAt < CACHE_TTL_MS) return
    void refresh().catch(() => undefined)
  }

  return {
    agenda: () => state.agenda,
    occurrences: () => state.agenda?.occurrences ?? [],
    failures: () => state.agenda?.failures ?? [],
    loading: () => state.loading,
    error: () => state.error,
    loadedAt: () => state.loadedAt,
    scope,
    load,
    refresh,
    refreshIfStale,
  } as const
}
