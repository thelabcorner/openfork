import type { QuotaResetsResponse } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import { useServerSDK, type ServerSDK } from "@/context/server-sdk"

type AgendaState = {
  data?: QuotaResetsResponse
  loading: boolean
  error?: unknown
  key?: string
}

type SharedAgendaTransport = {
  cache: Map<string, { at: number; value: QuotaResetsResponse }>
  inflight: Map<string, Promise<QuotaResetsResponse>>
}

const CACHE_TTL_MS = 15_000
const MAX_CACHE_ENTRIES = 6
const sharedByServer = new WeakMap<ServerSDK, SharedAgendaTransport>()

function transport(server: ServerSDK) {
  let current = sharedByServer.get(server)
  if (current) return current
  current = { cache: new Map(), inflight: new Map() }
  sharedByServer.set(server, current)
  return current
}

function rangeKey(from: number, to: number) {
  return `${from}:${to}`
}

function remember(cache: SharedAgendaTransport["cache"], key: string, value: QuotaResetsResponse) {
  cache.delete(key)
  cache.set(key, { at: Date.now(), value })
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

async function fetchAgenda(server: ServerSDK, from: number, to: number) {
  const key = rangeKey(from, to)
  const shared = transport(server)
  const cached = shared.cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    shared.cache.delete(key)
    shared.cache.set(key, cached)
    return cached.value
  }

  const pending = shared.inflight.get(key)
  if (pending) return pending

  const request = server.client.quota
    .resets({ from: String(from), to: String(to) }, { throwOnError: false })
    .then((response) => {
      const envelope = response as { data?: QuotaResetsResponse; error?: unknown }
      if (envelope.error || !envelope.data) throw envelope.error ?? new Error("quota reset agenda unavailable")
      remember(shared.cache, key, envelope.data)
      return envelope.data
    })
    .finally(() => shared.inflight.delete(key))

  shared.inflight.set(key, request)
  return request
}

/**
 * Calendar-scoped consumer for the quota-owned reset agenda.
 *
 * The hook does not poll providers, subscribe to quota streams, or reconstruct
 * reset semantics. The page explicitly requests one bounded Tier-0 projection
 * for its visible range; same-range calls are shared and short-lived cached.
 */
export function useQuotaResetAgenda() {
  const sdk = useServerSDK()
  const [state, setState] = createStore<AgendaState>({ loading: false })
  let revision = 0

  const load = async (from: number, to: number) => {
    const key = rangeKey(from, to)
    if (state.key === key && state.data && !state.error) return state.data

    const current = ++revision
    setState({ loading: true, error: undefined, key })
    try {
      const data = await fetchAgenda(sdk(), from, to)
      if (current !== revision) return data
      setState({ data, loading: false, error: undefined, key })
      return data
    } catch (error) {
      if (current !== revision) return
      setState({ loading: false, error, key })
    }
  }

  return {
    state,
    load,
  }
}
