import { createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"
import { useServerSDK } from "@/context/server-sdk"
import { Persist, persisted } from "@/utils/persist"
import {
  appendZenLimitHit,
  countZenFreeRequests,
  estimateZenFreeLimit,
  zenEstimateToProviderResult,
  ZEN_FREE_HISTORY_MS,
  ZEN_FREE_WINDOW_MS,
  type ZenLimitObservation,
} from "@/utils/zen-free-usage"

const BACKFILL_DAYS = 14
const BACKFILL_REFRESH_MS = ZEN_FREE_WINDOW_MS
const MAX_HIT_WINDOWS = 16
const QUERY_CONCURRENCY = 3
const OBSERVATION_DEDUPE_MS = 60_000
const GO_UPSELL_PROVIDERS = new Set(["opencode", "opencode-go"])

type Resolution = "hour" | "day"
type LearningStore = {
  entries: ZenLimitObservation[]
  lastBackfillAt: number
}
type HitStore = { entries: number[] }

type RangeJob = {
  at: number
  kind: ZenLimitObservation["kind"]
  since: number
  until: number
}

function isFreeTierLimitStatus(status: unknown) {
  if (!status || typeof status !== "object") return false
  const value = status as { type?: string; action?: { provider?: string; reason?: string } }
  return (
    value.type === "retry" &&
    value.action?.reason === "free_tier_limit" &&
    typeof value.action.provider === "string" &&
    GO_UPSELL_PROVIDERS.has(value.action.provider)
  )
}

function mergeObservations(current: readonly ZenLimitObservation[], incoming: readonly ZenLimitObservation[], now: number) {
  const merged = [...incoming, ...current]
    .filter(
      (item) =>
        Number.isFinite(item.at) &&
        Number.isFinite(item.requests) &&
        item.requests >= 0 &&
        item.at <= now &&
        now - item.at <= ZEN_FREE_HISTORY_MS,
    )
    .sort((a, b) => b.at - a.at)

  const result: ZenLimitObservation[] = []
  for (const item of merged) {
    if (result.some((existing) => existing.kind === item.kind && Math.abs(existing.at - item.at) < OBSERVATION_DEDUPE_MS)) continue
    result.push(item)
    if (result.length >= 100) break
  }
  return result
}

async function runPool<T>(jobs: readonly T[], concurrency: number, worker: (job: T) => Promise<void>) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= jobs.length) return
      await worker(jobs[index])
    }
  })
  await Promise.all(runners)
}

/**
 * First-party OpenCode Zen free-tier tracker.
 *
 * Current usage comes from the exact same `usage.summary` DB-backed endpoint
 * as the Usage pane. A compact persisted observation log learns the quota over
 * time: recent structured limit hits are high-confidence cap observations,
 * while successful historical 24h windows remain censored lower bounds.
 */
export function useZenFreeUsage() {
  const serverSDK = useServerSDK()
  const scope = serverSDK().scope
  const [learning, setLearning, , learningReady] = persisted(
    Persist.serverGlobal(scope, "zen-free-usage-learning"),
    createStore<LearningStore>({ entries: [], lastBackfillAt: 0 }),
  )
  // Written by the always-mounted usage-exceeded session observer. This hook
  // intentionally treats it as read-only to avoid two persistence writers.
  const [persistedHits, , , hitsReady] = persisted(
    Persist.serverGlobal(scope, "zen-free-tier-hits"),
    createStore<HitStore>({ entries: [] }),
  )

  const [refreshTick, setRefreshTick] = createSignal(0)
  const [liveHits, setLiveHits] = createSignal<number[]>([])
  const [liveObservations, setLiveObservations] = createSignal<ZenLimitObservation[]>([])

  async function fetchSummary(since: number, until: number, resolution: Resolution) {
    const client = serverSDK().client
    if (!client.usage?.summary) throw new Error("usage.summary endpoint unavailable")
    const response = await client.usage.summary(
      { since, until, resolution },
      { throwOnError: true },
    )
    return (response.data ?? null) as UsageSummaryResponse | null
  }

  const [current, { refetch: refetchCurrent }] = createResource(
    () => refreshTick(),
    async () => {
      const fetchedAt = Date.now()
      const summary = await fetchSummary(fetchedAt - ZEN_FREE_WINDOW_MS, fetchedAt, "hour")
      return { used: countZenFreeRequests(summary), fetchedAt }
    },
  )

  let learningInFlight = false
  let learningQueued = false

  const allHitTimes = () => {
    const merged = [...liveHits(), ...persistedHits.entries]
      .filter((at) => Number.isFinite(at) && at > 0)
      .sort((a, b) => b - a)
    const result: number[] = []
    for (const at of merged) {
      const next = appendZenLimitHit(result, at)
      if (next.length === result.length) continue
      result.splice(0, result.length, ...next)
    }
    return result
  }

  async function refreshLearning() {
    if (!learningReady() || !hitsReady()) return
    if (learningInFlight) {
      learningQueued = true
      return
    }
    learningInFlight = true
    try {
      const now = Date.now()
      const existing = learning.entries
      const jobs: RangeJob[] = []
      const needsBackfill = !learning.lastBackfillAt || now - learning.lastBackfillAt >= BACKFILL_REFRESH_MS

      if (needsBackfill) {
        // Stable, complete UTC 24h slices. Fourteen local DB queries once per
        // day is intentionally bounded; normal refreshes only query current
        // usage, so this does not turn the Limits heartbeat into DB churn.
        const anchor = Math.floor(now / ZEN_FREE_WINDOW_MS) * ZEN_FREE_WINDOW_MS
        for (let index = 0; index < BACKFILL_DAYS; index++) {
          const until = anchor - index * ZEN_FREE_WINDOW_MS
          const since = until - ZEN_FREE_WINDOW_MS
          const already = existing.some(
            (item) => item.kind === "lower-bound" && Math.abs(item.at - until) < OBSERVATION_DEDUPE_MS,
          )
          if (!already) jobs.push({ at: until, kind: "lower-bound", since, until })
        }
      }

      for (const at of allHitTimes().slice(0, MAX_HIT_WINDOWS)) {
        if (now - at > ZEN_FREE_HISTORY_MS) continue
        const already = existing.some(
          (item) => item.kind === "limit-hit" && Math.abs(item.at - at) < OBSERVATION_DEDUPE_MS,
        )
        if (already) continue
        jobs.push({ at, kind: "limit-hit", since: at - ZEN_FREE_WINDOW_MS, until: at })
      }

      const observations: ZenLimitObservation[] = []
      await runPool(jobs, QUERY_CONCURRENCY, async (job) => {
        try {
          const summary = await fetchSummary(job.since, job.until, "day")
          observations.push({ at: job.at, requests: countZenFreeRequests(summary), kind: job.kind })
        } catch {
          // A failed historical sample should not break live quota display.
          // It will be retried on the next bounded learning pass.
        }
      })

      if (observations.length > 0) {
        setLearning("entries", mergeObservations(learning.entries, observations, now))
        const calibratedHits = new Set(observations.filter((item) => item.kind === "limit-hit").map((item) => item.at))
        if (calibratedHits.size > 0) {
          setLiveObservations((items) => items.filter((item) => !calibratedHits.has(item.at)))
        }
      }
      if (needsBackfill) setLearning("lastBackfillAt", now)
    } finally {
      learningInFlight = false
      if (learningQueued) {
        learningQueued = false
        void refreshLearning()
      }
    }
  }

  createEffect(() => {
    if (!learningReady() || !hitsReady()) return
    void persistedHits.entries.length
    void refreshTick()
    void refreshLearning()
  })

  const unsubscribe = serverSDK().event.listen((event) => {
    const details = event.details
    if (details?.type !== "session.status") return
    if (!isFreeTierLimitStatus(details.properties?.status)) return

    const at = Date.now()
    setLiveHits((entries) => appendZenLimitHit(entries, at))
    const used = current.latest?.used
    if (typeof used === "number" && used > 0) {
      setLiveObservations((entries) =>
        mergeObservations(entries, [{ at, requests: used, kind: "limit-hit" }], at),
      )
    }
    void refetchCurrent()
    void refreshLearning()
  })
  onCleanup(unsubscribe)

  const estimate = createMemo(() => {
    const latest = current()
    if (!latest) return undefined
    return estimateZenFreeLimit({
      now: latest.fetchedAt,
      used: latest.used,
      observations: [...liveObservations(), ...learning.entries],
    })
  })

  const result = createMemo(() => {
    const latest = current()
    const value = estimate()
    if (!latest || !value) return undefined
    return zenEstimateToProviderResult(value, latest.fetchedAt)
  })

  return {
    result,
    estimate,
    isLoading: () => current.loading,
    error: () => current.error,
    refresh() {
      setRefreshTick((value) => value + 1)
    },
  } as const
}
