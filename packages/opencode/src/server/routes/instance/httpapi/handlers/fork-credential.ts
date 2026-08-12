import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { ForkCredentials } from "@/fork/credentials"
import { SessionUsage } from "@opencode-ai/core/session/usage"
import { disposeInstance } from "@/effect/instance-registry"
import { RootHttpApi } from "../api"
import {
  buildAggregateWindows,
  buildLocalWindows,
  bumpUsageCache,
  localUsageCache,
  officialUsageCache,
  type LocalWindow,
  type OfficialUsage,
  type WindowBounds,
} from "@/fork/usage-cache"

type ForkWindowLabel = "5h" | "week" | "month"
type CredentialWindows = {
  readonly credentialID: string
  readonly windows: LocalWindow[]
  readonly official?: {
    readonly fetchedAt: number
    readonly ageMs: number
    readonly status: "ok" | "stale" | "error"
  }
}

export const forkCredentialHandlers = HttpApiBuilder.group(RootHttpApi, "fork-credential", (handlers) =>
  Effect.gen(function* () {
    const credentials = yield* ForkCredentials.Service
    const usage = yield* SessionUsage.Service

    const refresh = (directory?: string) =>
      directory ? Effect.promise(() => disposeInstance(directory)).pipe(Effect.asVoid) : Effect.void

    // Invalidate the local aggregation cache after any credential mutation so
    // the next /fork/usage reflects the change immediately. (recordUsage bumps
    // via ForkCredentials internally; remote official data stays gate-limited.)
    const bumpAfterMutation = Effect.fn("ForkCredentialHttpApi.bumpAfterMutation")(function* () {
      bumpUsageCache()
    })

    const list = Effect.fn("ForkCredentialHttpApi.list")(function* () {
      return yield* credentials.list()
    })

    const add = Effect.fn("ForkCredentialHttpApi.add")(function* (ctx: {
      payload: { key: string; label?: string }
      query: { directory?: string }
    }) {
      if (!ctx.payload.key.trim()) return yield* Effect.fail(new HttpApiError.BadRequest())
      const created = yield* credentials.add({ key: ctx.payload.key, label: ctx.payload.label })
      yield* bumpAfterMutation()
      yield* refresh(ctx.query.directory)
      return created
    })

    const select = Effect.fn("ForkCredentialHttpApi.select")(function* (ctx: {
      params: { id: string }
      query: { directory?: string }
    }) {
      yield* credentials.select(ctx.params.id)
      yield* bumpAfterMutation()
      yield* refresh(ctx.query.directory)
      return true
    })

    const rename = Effect.fn("ForkCredentialHttpApi.rename")(function* (ctx: {
      params: { id: string }
      payload: { label: string }
    }) {
      yield* credentials.rename(ctx.params.id, ctx.payload.label)
      yield* bumpAfterMutation()
      return true
    })

    const remove = Effect.fn("ForkCredentialHttpApi.remove")(function* (ctx: {
      params: { id: string }
      query: { directory?: string }
    }) {
      yield* credentials.remove(ctx.params.id)
      yield* bumpAfterMutation()
      yield* refresh(ctx.query.directory)
      return true
    })

    // L2: local spend/calls from the DB, cached process-globally and
    // invalidated by the generation counter (recordUsage + mutations). No
    // remote calls in this layer, so local values refresh in ~2-5s via the
    // SSE-driven client refetch without touching the official API.
    const getLocal = Effect.fn("ForkCredentialHttpApi.local")(function* () {
      return yield* localUsageCache.get(() =>
        Effect.gen(function* () {
          const bounds = yield* usage.windows()
          const allCredentials = yield* credentials.list()
          const grouped = yield* credentials.usageByCredential(bounds)
          const byCredential = new Map(
            allCredentials.map((credential) => [
              credential.id,
              buildLocalWindows(bounds, grouped.byCredential.get(credential.id) ?? []),
            ]),
          )
          const aggregate = buildAggregateWindows(bounds, grouped.byCredential, grouped.unattributed)
          return { bounds, allCredentials, byCredential, aggregate }
        }),
      )
    })

    const getUsage = Effect.fn("ForkCredentialHttpApi.usage")(function* () {
      const { bounds, allCredentials, byCredential, aggregate } = yield* getLocal()

      if (allCredentials.length === 0) {
        // Zero credentials: local aggregate + empty per-credential, and NO
        // external calls (nothing to ask the official API about).
        return { aggregate, byCredential: [] }
      }

      // L1: gated official snapshots per credential (>=5m per credential).
      // Serving the cached snapshot (fresh or stale-with-metadata) never
      // triggers a synchronous remote call; the gate is module-scope.
      const officialByCredential = yield* Effect.forEach(
        allCredentials,
        (credential): Effect.Effect<CredentialWindows> =>
          Effect.map(officialUsageCache.get(credential.id, credential.key), (official) => ({
            credentialID: credential.id,
            windows: mergeOfficial(byCredential.get(credential.id) ?? [], official.snapshot ?? {}),
            official: {
              fetchedAt: official.fetchedAt,
              ageMs: official.ageMs,
              status: official.status,
            },
          })),
        { concurrency: 4 },
      )

      return {
        aggregate: aggregateWindows(aggregate, officialByCredential.map((entry) => entry.windows)),
        byCredential: officialByCredential,
      }
    })

    return handlers
      .handle("list", list)
      .handle("add", add)
      .handle("select", select)
      .handle("rename", rename)
      .handle("remove", remove)
      .handle("usage", getUsage)
  }),
)

function mergeOfficial(local: LocalWindow[], official: OfficialUsage): LocalWindow[] {
  return local.map((window) => {
    const next = official[window.label]
    if (!next) return window
    return {
      ...window,
      spentUSD: window.limitUSD * (Math.max(0, Math.min(100, next.percent)) / 100),
      estimatedPercent: estimatePercent(window, next.percent),
      resetsAt: next.resetsAt,
      clearsAt: window.label === "5h" ? next.resetsAt : next.resetsAt,
      source: "api" as const,
      status: next.status,
    }
  })
}

function estimatePercent(window: LocalWindow, officialPercent: number) {
  const official = Math.max(0, Math.min(100, officialPercent))
  if (!Number.isInteger(official)) return official
  const local = percentFor(window.spentUSD, window.limitUSD)
  if (!Number.isFinite(local)) return undefined
  if (official >= 100) return 100
  if (Math.floor(local) === official) return roundPercent(local)
  if (Math.round(local) === official && Math.abs(local - official) <= 0.5) return roundPercent(local)
  return undefined
}

function percentFor(spentUSD: number, limitUSD: number) {
  if (limitUSD <= 0) return 0
  return Math.max(0, Math.min(100, (spentUSD / limitUSD) * 100))
}

function roundPercent(percent: number) {
  return Math.round(percent * 100) / 100
}

function aggregateWindows(local: LocalWindow[], byCredential: LocalWindow[][]) {
  return local.map((window) => {
    const windows = byCredential
      .map((windows) => windows.find((item) => item.label === window.label))
      .filter((item): item is LocalWindow => !!item)
    if (!windows.some((item) => item.source === "api")) return window
    const resetsAt = Math.min(...windows.map((item) => item.resetsAt))
    const spentUSD = windows.reduce((total, item) => total + item.spentUSD, 0)
    const limitUSD = windows.reduce((total, item) => total + item.limitUSD, 0)
    const estimatedSpentUSD = windows.reduce(
      (total, item) => total + item.limitUSD * ((item.estimatedPercent ?? percentFor(item.spentUSD, item.limitUSD)) / 100),
      0,
    )
    return {
      ...window,
      spentUSD,
      limitUSD,
      estimatedPercent: windows.some((item) => item.estimatedPercent !== undefined)
        ? roundPercent(percentFor(estimatedSpentUSD, limitUSD))
        : undefined,
      resetsAt,
      clearsAt: window.label === "5h" ? resetsAt : resetsAt,
      source: "api" as const,
      status: windows.some((item) => item.source !== "api" || (item.status && item.status !== "ok")) ? "mixed" : "ok",
    }
  })
}
