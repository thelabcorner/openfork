import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createEffect, createMemo, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { useServerSync } from "@/context/server-sync"
import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2/client"

type CostSample = { id: string; cost: number; ts: number }
type HitSample = { id: string; input: number; cacheRead: number; ts: number }

type Store = {
  version: 1
  costs: Record<string, CostSample[]>
  hits: Record<string, HitSample[]>
}

const MAX_SAMPLES_PER_MODEL = 200
const MAX_MODELS = 400
const MAX_TOTAL_SAMPLES = 8000
const STORAGE_KEY = "model.personal.v2"
const LEGACY_KEYS = ["model.personal.v1", "personal-cost.v1"]

function extractHit(assistant: AssistantMessage): { input: number; cacheRead: number } | undefined {
  const tokensAny = assistant.tokens as unknown as Record<string, unknown> | undefined
  if (!tokensAny) return undefined
  const inputRaw = (tokensAny as { input?: unknown }).input
  const cacheObj = tokensAny.cache as Record<string, unknown> | undefined
  const cacheReadRaw =
    cacheObj && typeof cacheObj.read === "number"
      ? (cacheObj.read as number)
      : typeof tokensAny.cacheRead === "number"
        ? (tokensAny.cacheRead as number)
        : 0
  const fallbackInput = typeof tokensAny.input === "number" ? (tokensAny.input as number) : 0
  const input = typeof inputRaw === "number" ? (inputRaw as number) : fallbackInput
  const actualCacheRead =
    typeof (tokensAny.cache as Record<string, unknown> | undefined)?.["read"] === "number"
      ? ((tokensAny.cache as Record<string, unknown>)["read"] as number)
      : typeof tokensAny.cacheRead === "number"
        ? (tokensAny.cacheRead as number)
        : cacheReadRaw
  const actualInput = typeof tokensAny["input"] === "number" ? (tokensAny["input"] as number) : input
  if (!(actualInput > 0 || actualCacheRead > 0)) return undefined
  return { input: actualInput, cacheRead: actualCacheRead }
}

function pruneIfNeeded(costs: Record<string, CostSample[]>, hits: Record<string, HitSample[]>) {
  const costKeys = Object.keys(costs)
  if (costKeys.length > MAX_MODELS) {
    // Evict least recently used models (oldest max ts)
    const withMaxTs = costKeys
      .map((k) => {
        const arr = costs[k] ?? []
        const maxTs = arr.length ? Math.max(...arr.map((s) => s.ts)) : 0
        return { k, maxTs }
      })
      .sort((a, b) => a.maxTs - b.maxTs)
    const toRemove = withMaxTs.slice(0, costKeys.length - MAX_MODELS).map((x) => x.k)
    for (const k of toRemove) {
      delete costs[k]
      delete hits[k]
    }
  }
  // Total samples cap
  let total = 0
  for (const arr of Object.values(costs)) total += arr.length
  for (const arr of Object.values(hits)) total += arr.length
  if (total <= MAX_TOTAL_SAMPLES) return
  // Remove oldest samples globally until under cap
  type Entry = { key: string; kind: "cost" | "hit"; ts: number; idx: number }
  const entries: Entry[] = []
  for (const [k, arr] of Object.entries(costs)) arr.forEach((s, idx) => entries.push({ key: k, kind: "cost", ts: s.ts, idx }))
  for (const [k, arr] of Object.entries(hits)) arr.forEach((s, idx) => entries.push({ key: k, kind: "hit", ts: s.ts, idx }))
  entries.sort((a, b) => a.ts - b.ts)
  const over = total - MAX_TOTAL_SAMPLES
  const toDelete = entries.slice(0, over)
  // Group deletions by key/kind
  const grouped = new Map<string, { cost: Set<number>; hit: Set<number> }>()
  for (const e of toDelete) {
    let g = grouped.get(e.key)
    if (!g) {
      g = { cost: new Set(), hit: new Set() }
      grouped.set(e.key, g)
    }
    if (e.kind === "cost") g.cost.add(e.idx)
    else g.hit.add(e.idx)
  }
  for (const [k, g] of grouped) {
    if (g.cost.size) {
      const arr = costs[k]
      if (arr) costs[k] = arr.filter((_, idx) => !g.cost.has(idx))
      if (costs[k]?.length === 0) delete costs[k]
    }
    if (g.hit.size) {
      const arr = hits[k]
      if (arr) hits[k] = arr.filter((_, idx) => !g.hit.has(idx))
      if (hits[k]?.length === 0) delete hits[k]
    }
  }
}

export const { use: usePersonalUsage, provider: PersonalUsageProvider } = createSimpleContext({
  name: "PersonalUsage",
  gate: false,
  init: () => {
    const [store, setStore, , ready] = persisted(
      Persist.global(STORAGE_KEY, LEGACY_KEYS),
      createStore<Store>({
        version: 1,
        costs: {},
        hits: {},
      }),
    )

    const personalCosts = createMemo(() => {
      if (!ready()) return new Map<string, { cost: number; count: number }>()
      const map = new Map<string, { cost: number; count: number }>()
      const costs = store.costs
      for (const [key, samples] of Object.entries(costs)) {
        if (!samples || samples.length === 0) continue
        let sum = 0
        for (const s of samples) sum += s.cost
        map.set(key, { cost: sum / samples.length, count: samples.length })
      }
      return map
    })

    const hitRates = createMemo(() => {
      if (!ready()) return new Map<string, number>()
      const map = new Map<string, number>()
      const hits = store.hits
      for (const [key, samples] of Object.entries(hits)) {
        if (!samples || samples.length < 3) continue
        let inputSum = 0
        let cacheSum = 0
        for (const s of samples) {
          inputSum += s.input
          cacheSum += s.cacheRead
        }
        const denom = inputSum + cacheSum
        if (denom > 0) map.set(key, cacheSum / denom)
      }
      return map
    })

    const ingest = (messagesBySession: Record<string, Message[] | undefined>) => {
      if (!ready()) return
      // Build quick lookup for existing ids to achieve O(1) dedupe
      const existingCostIds = new Map<string, Set<string>>()
      const existingHitIds = new Map<string, Set<string>>()
      const costsSnap = untrack(() => store.costs)
      const hitsSnap = untrack(() => store.hits)
      for (const [k, arr] of Object.entries(costsSnap)) existingCostIds.set(k, new Set(arr.map((s) => s.id)))
      for (const [k, arr] of Object.entries(hitsSnap)) existingHitIds.set(k, new Set(arr.map((s) => s.id)))

      let changed = false
      const pendingCosts: Record<string, CostSample[]> = {}
      const pendingHits: Record<string, HitSample[]> = {}

      let scanned = 0
      const MAX_SCANNED = 20_000
      outer: for (const messages of Object.values(messagesBySession)) {
        if (!messages) continue
        for (const msg of messages) {
          if (scanned >= MAX_SCANNED) break outer
          scanned++
          if (msg.role !== "assistant") continue
          const assistant = msg as AssistantMessage
          const ts = (msg.time as { created?: number } | undefined)?.created ?? Date.now()
          const key = `${assistant.providerID}:${assistant.modelID}`
          // Cost
          if (assistant.cost > 0) {
            let set = existingCostIds.get(key)
            if (!set) {
              set = new Set()
              existingCostIds.set(key, set)
            }
            if (!set.has(msg.id)) {
              set.add(msg.id)
              changed = true
              const arr = pendingCosts[key] ?? (pendingCosts[key] = [])
              arr.push({ id: msg.id, cost: assistant.cost, ts })
            }
          }
          // Hit rate
          const hit = extractHit(assistant)
          if (hit) {
            let set = existingHitIds.get(key)
            if (!set) {
              set = new Set()
              existingHitIds.set(key, set)
            }
            if (!set.has(msg.id)) {
              set.add(msg.id)
              changed = true
              const arr = pendingHits[key] ?? (pendingHits[key] = [])
              arr.push({ id: msg.id, input: hit.input, cacheRead: hit.cacheRead, ts })
            }
          }
        }
      }

      if (!changed) return

      batch(() => {
        // Merge costs (filter duplicates at write time to handle concurrent ingests)
        for (const [key, newSamples] of Object.entries(pendingCosts)) {
          const existing = store.costs[key] ?? []
          const existingIds = new Set(existing.map((s) => s.id))
          const filtered = newSamples.filter((s) => !existingIds.has(s.id))
          if (filtered.length === 0) continue
          const merged = [...existing, ...filtered]
          // Sort by ts ascending, keep most recent MAX_SAMPLES_PER_MODEL
          if (merged.length > MAX_SAMPLES_PER_MODEL) {
            merged.sort((a, b) => a.ts - b.ts)
            const sliced = merged.slice(merged.length - MAX_SAMPLES_PER_MODEL)
            setStore("costs", key, sliced)
          } else {
            setStore("costs", key, merged)
          }
        }
        for (const [key, newSamples] of Object.entries(pendingHits)) {
          const existing = store.hits[key] ?? []
          const existingIds = new Set(existing.map((s) => s.id))
          const filtered = newSamples.filter((s) => !existingIds.has(s.id))
          if (filtered.length === 0) continue
          const merged = [...existing, ...filtered]
          if (merged.length > MAX_SAMPLES_PER_MODEL) {
            merged.sort((a, b) => a.ts - b.ts)
            const sliced = merged.slice(merged.length - MAX_SAMPLES_PER_MODEL)
            setStore("hits", key, sliced)
          } else {
            setStore("hits", key, merged)
          }
        }
        // Prune if over limits (needs untracked snapshot after writes)
        // Use a microtask to prune to avoid reading pending writes in same batch
        queueMicrotask(() => {
          const costs = untrack(() => store.costs)
          const hits = untrack(() => store.hits)
          // Shallow clone for mutation check
          const costsClone: Record<string, CostSample[]> = {}
          const hitsClone: Record<string, HitSample[]> = {}
          let needsPrune = false
          if (Object.keys(costs).length > MAX_MODELS) needsPrune = true
          let total = 0
          for (const arr of Object.values(costs)) total += arr.length
          for (const arr of Object.values(hits)) total += arr.length
          if (total > MAX_TOTAL_SAMPLES) needsPrune = true
          if (!needsPrune) return
          for (const [k, v] of Object.entries(costs)) costsClone[k] = [...v]
          for (const [k, v] of Object.entries(hits)) hitsClone[k] = [...v]
          pruneIfNeeded(costsClone, hitsClone)
          // Apply diff: remove keys not in clone, update truncated ones
          batch(() => {
            for (const k of Object.keys(costs)) {
              if (!(k in costsClone)) setStore("costs", k, undefined as unknown as CostSample[])
            }
            for (const [k, v] of Object.entries(costsClone)) {
              const cur = store.costs[k]
              if (!cur || cur.length !== v.length || cur.some((s, i) => s.id !== v[i].id)) {
                setStore("costs", k, v)
              }
            }
            for (const k of Object.keys(hits)) {
              if (!(k in hitsClone)) setStore("hits", k, undefined as unknown as HitSample[])
            }
            for (const [k, v] of Object.entries(hitsClone)) {
              const cur = store.hits[k]
              if (!cur || cur.length !== v.length || cur.some((s, i) => s.id !== v[i].id)) {
                setStore("hits", k, v)
              }
            }
          })
        })
      })
    }

    const clear = () => {
      batch(() => {
        setStore("costs", {})
        setStore("hits", {})
      })
    }

    const getCost = (providerID: string, modelID: string) => {
      const key = `${providerID}:${modelID}`
      const entry = personalCosts().get(key)
      return entry
    }

    const getHitRate = (providerID: string, modelID: string) => {
      const key = `${providerID}:${modelID}`
      return hitRates().get(key)
    }

    return {
      ready,
      store,
      personalCosts,
      hitRates,
      ingest,
      clear,
      getCost,
      getHitRate,
    }
  },
})

export function PersonalUsageIngest() {
  let serverSync: ReturnType<typeof useServerSync> | undefined
  try {
    serverSync = useServerSync()
  } catch {
    return null as unknown as null
  }
  const personal = usePersonalUsage()
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const msgMap = serverSync!().session.data.message
    // depend on total count + ready to trigger
    const total = Object.values(msgMap).reduce((sum, arr) => sum + (arr?.length ?? 0), 0)
    void total
    if (!personal.ready()) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      // ingest is idempotent via dedupe, safe to call frequently
      personal.ingest(msgMap)
    }, 650)
  })
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })
  return null as unknown as null
}
