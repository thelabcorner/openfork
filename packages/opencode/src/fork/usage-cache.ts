export * as UsageCache from "./usage-cache"

import { Effect } from "effect"

/**
 * Fork-owned, process-global usage caches for the OpenCode Go usage arc.
 *
 * Deliberately MODULE-SCOPED, not service/layer-scoped: `ForkCredentials.node`
 * and `Auth.node` are plain `LayerNode.make` (not `makeGlobalNode`), so any
 * cache created inside a layer closure could be instantiated per location and
 * two directories would each hit the official API — breaking the hard
 * >=5min-per-credential remote gate. Module state is process-global: the
 * desktop app spawns ONE server process shared by all windows, so one gate
 * here gates every window.
 *
 * Two layers (coordinator constraint, decisions/usage-rate-limit):
 * - L1 OFFICIAL GATE: per-credential official snapshot cache + single-flight,
 *   TTL >= 5 minutes. Exactly one remote fetch per credential per window,
 *   regardless of polls/SSE/switches/concurrency. Remote failure serves the
 *   last good snapshot (stale) — never blocks on the remote.
 * - L2 LOCAL AGGREGATION: generation-invalidated local computation cache
 *   (bumped by ForkCredentials.recordUsage and credential mutations), TTL
 *   15s. Local spend/calls refresh without any remote call.
 */

const GO_PROVIDER_ID = "opencode-go"

export const OFFICIAL_TTL_MS = 5 * 60 * 1000
export const OFFICIAL_TIMEOUT_MS = 5_000
export const LOCAL_TTL_MS = 15_000
export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
export const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"

// Generation counter ----------------------------------------------------------
// Bumped by ForkCredentials.recordUsage (per assistant step) and by credential
// mutations, so L2 recomputes fresh local numbers without a remote call.
let generation = 0

export const bumpUsageCache = () => {
  generation++
}

export const usageCacheGeneration = () => generation

// L1 — official snapshot gate -------------------------------------------------

export type OfficialWindow = { percent: number; resetsAt: number; status?: string }
export type OfficialUsage = Partial<Record<"5h" | "week" | "month", OfficialWindow>>
export type OfficialStatus = "ok" | "stale" | "error"

export type OfficialSnapshot = {
  readonly snapshot: OfficialUsage | undefined
  readonly fetchedAt: number
  readonly ageMs: number
  readonly status: OfficialStatus
}

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface OfficialUsageCache {
  readonly get: (credentialID: string, key: string) => Effect.Effect<OfficialSnapshot>
}

export function createOfficialUsageCache(options: {
  readonly now?: () => number
  readonly fetch?: FetchFn
  readonly ttlMs?: number
  readonly timeoutMs?: number
} = {}): OfficialUsageCache {
  const now = options.now ?? Date.now
  const fetchImpl = options.fetch ?? globalThis.fetch
  const ttlMs = options.ttlMs ?? OFFICIAL_TTL_MS
  const timeoutMs = options.timeoutMs ?? OFFICIAL_TIMEOUT_MS

  type Entry = {
    snapshot: OfficialUsage | undefined
    fetchedAt: number
    status: OfficialStatus
    inFlight: Promise<OfficialUsage | undefined> | undefined
    inFlightAt: number
  }
  const entries = new Map<string, Entry>()

  const runFetch = (key: string): Promise<OfficialUsage | undefined> =>
    fetchImpl(GO_USAGE_URL, {
      headers: { authorization: `Bearer ${key}` },
      // A hung official endpoint must not stall the usage request indefinitely.
      signal: AbortSignal.timeout(timeoutMs),
    })
      .then((response) => (response.ok ? response.json() : undefined))
      .then(decodeOfficialUsage)
      .catch(() => undefined)

  const get = Effect.fn("OfficialUsageCache.get")(function* (credentialID: string, key: string) {
    let entry = entries.get(credentialID)
    if (!entry) {
      entry = { snapshot: undefined, fetchedAt: 0, status: "error", inFlight: undefined, inFlightAt: 0 }
      entries.set(credentialID, entry)
    }
    const at = now()
    // Single-flight: the in-flight promise is shared by every concurrent caller
    // within the TTL window (set synchronously before any yield), so the gate
    // holds <=1 remote fetch per credential per window even under bursts.
    if (!entry.inFlight || at - entry.inFlightAt >= ttlMs) {
      entry.inFlight = runFetch(key)
      entry.inFlightAt = at
    }
    const result = yield* Effect.promise(() => entry.inFlight!)
    if (result) {
      entry.snapshot = result
      entry.fetchedAt = at
      entry.status = "ok"
    } else if (entry.snapshot) {
      entry.status = "stale"
    } else {
      entry.status = "error"
    }
    return {
      snapshot: entry.snapshot,
      fetchedAt: entry.fetchedAt,
      ageMs: Math.max(0, at - entry.fetchedAt),
      status: entry.status,
    }
  })

  return { get }
}

// The one process-global gate the /fork/usage handler uses. Tests build their
// own instances via createOfficialUsageCache with injected clock/fetch.
export const officialUsageCache = createOfficialUsageCache()

// L2 — local aggregation cache -------------------------------------------------

export interface LocalUsageCache {
  readonly get: <T>(compute: () => Effect.Effect<T>) => Effect.Effect<T>
}

export function createLocalUsageCache(options: { readonly now?: () => number; readonly ttlMs?: number } = {}): LocalUsageCache {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? LOCAL_TTL_MS
  let cached: { generation: number; at: number; value: unknown } | undefined

  return {
    get: Effect.fn("LocalUsageCache.get")(function* (compute) {
      const gen = usageCacheGeneration()
      const at = now()
      if (cached && cached.generation === gen && at - cached.at < ttlMs) return cached.value as never
      const value = yield* compute()
      cached = { generation: gen, at, value }
      return value
    }),
  }
}

// Process-global L2 cache shared by every request (the DB is global, so one
// cached local computation serves all windows; generation keeps it fresh).
export const localUsageCache = createLocalUsageCache()

// Pure window math shared by the handler and the grouped-SQL equivalence tests --

export type ForkWindowLabel = "5h" | "week" | "month"

export interface LocalWindow {
  readonly label: ForkWindowLabel
  readonly spentUSD: number
  readonly limitUSD: number
  readonly estimatedPercent?: number
  readonly resetsAt: number
  readonly clearsAt: number
  readonly lastUsedAt?: number
  readonly callsInWindow: number
  readonly source: "api" | "local"
  readonly status?: string
}

export interface WindowBounds {
  readonly label: ForkWindowLabel
  readonly startMs: number
  readonly endMs: number
  readonly limitUSD: number
  readonly resetsAt: number
}

export interface UsageBucket {
  readonly spentUSD: number
  readonly callsInWindow: number
  readonly minCreatedMs: number | null
  readonly maxCreatedMs: number | null
}

const EMPTY_BUCKETS: readonly UsageBucket[] = []

// One credential's local windows from its grouped-SQL buckets (aligned to
// bounds order). Mirrors the pre-optimization JS aggregation exactly.
export function buildLocalWindows(bounds: readonly WindowBounds[], buckets: readonly UsageBucket[]): LocalWindow[] {
  return bounds.map((bound, index) => {
    const bucket = buckets[index]
    if (!bucket) return emptyWindow(bound)
    const lastUsedAt = bucket.maxCreatedMs
    const resetAt =
      bound.label === "5h"
        ? (bucket.minCreatedMs ?? bound.endMs) + FIVE_HOURS_MS
        : bound.resetsAt
    return {
      label: bound.label,
      spentUSD: bucket.spentUSD,
      limitUSD: bound.limitUSD,
      resetsAt: resetAt,
      clearsAt: bound.label === "5h" && lastUsedAt !== null ? lastUsedAt + FIVE_HOURS_MS : resetAt,
      lastUsedAt: lastUsedAt !== null ? lastUsedAt : undefined,
      callsInWindow: bucket.callsInWindow,
      source: "local" as const,
    }
  })
}

// Aggregate local windows: sums every credential bucket plus unattributed rows
// (the NULL-bucket from the LEFT JOIN), matching the old sumFor(() => true).
export function buildAggregateWindows(
  bounds: readonly WindowBounds[],
  byCredential: ReadonlyMap<string, readonly UsageBucket[]>,
  unattributed: readonly UsageBucket[],
): LocalWindow[] {
  return bounds.map((bound, index) => {
    const buckets = [...byCredential.values(), unattributed]
      .map((list) => list[index])
      .filter((bucket): bucket is UsageBucket => !!bucket)
    const lastUsedAt = Math.max(...buckets.map((bucket) => bucket.maxCreatedMs ?? -Infinity))
    const resetAt =
      bound.label === "5h"
        ? Math.min(...buckets.map((bucket) => bucket.minCreatedMs ?? bound.endMs), bound.endMs) + FIVE_HOURS_MS
        : bound.resetsAt
    return {
      label: bound.label,
      spentUSD: buckets.reduce((total, bucket) => total + bucket.spentUSD, 0),
      limitUSD: bound.limitUSD,
      resetsAt: resetAt,
      clearsAt: bound.label === "5h" && Number.isFinite(lastUsedAt) ? lastUsedAt + FIVE_HOURS_MS : resetAt,
      lastUsedAt: Number.isFinite(lastUsedAt) ? lastUsedAt : undefined,
      callsInWindow: buckets.reduce((total, bucket) => total + bucket.callsInWindow, 0),
      source: "local" as const,
    }
  })
}

function emptyWindow(bound: WindowBounds): LocalWindow {
  return {
    label: bound.label,
    spentUSD: 0,
    limitUSD: bound.limitUSD,
    resetsAt: bound.resetsAt,
    clearsAt: bound.resetsAt,
    callsInWindow: 0,
    source: "local" as const,
  }
}

function decodeOfficialUsage(input: unknown): OfficialUsage | undefined {
  if (!isRecord(input) || !isRecord(input.usage)) return undefined
  return {
    "5h": decodeOfficialWindow(input.usage.rolling),
    week: decodeOfficialWindow(input.usage.weekly),
    month: decodeOfficialWindow(input.usage.monthly),
  }
}

function decodeOfficialWindow(input: unknown): OfficialWindow | undefined {
  if (!isRecord(input)) return undefined
  if (typeof input.percent !== "number" || typeof input.resetsAt !== "string") return undefined
  const resetsAt = Date.parse(input.resetsAt)
  if (!Number.isFinite(resetsAt)) return undefined
  return {
    percent: input.percent,
    resetsAt,
    status: typeof input.status === "string" ? input.status : undefined,
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null
}

export { GO_PROVIDER_ID }
