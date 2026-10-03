import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Auth } from "@/auth"
import { ForkCredentials } from "@/fork/credentials"
import { Capacity } from "@/capacity/capacity"
import { Quota } from "@/quota/quota"
import type { ProviderResult } from "@/quota/schema"
import { SessionUsage } from "@opencode-ai/core/session/usage"
import { disposeInstance } from "@/effect/instance-registry"
import { RootHttpApi } from "../api"
import { bumpZenVaultPool } from "@/plugin/zen"
import { bumpUsageCache } from "@/fork/usage-cache"
import { forkUsageSnapshot, officialUsedPercent } from "@/fork/usage"

export const forkCredentialHandlers = HttpApiBuilder.group(RootHttpApi, "fork-credential", (handlers) =>
  Effect.gen(function* () {
    const credentials = yield* ForkCredentials.Service
    const usage = yield* SessionUsage.Service
    const auth = yield* Auth.Service
    const capacity = yield* Capacity.Service
    const quota = yield* Quota.Service

    const refresh = (directory?: string) =>
      directory ? Effect.promise(() => disposeInstance(directory)).pipe(Effect.asVoid) : Effect.void

    // Invalidate the local aggregation cache after any credential mutation so
    // the next /fork/usage reflects the change immediately. (recordUsage bumps
    // via ForkCredentials internally; remote official data stays gate-limited.)
    const bumpAfterMutation = Effect.fn("ForkCredentialHttpApi.bumpAfterMutation")(function* () {
      bumpUsageCache()
      bumpZenVaultPool()
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

    const setDefault = Effect.fn("ForkCredentialHttpApi.setDefault")(function* (ctx: {
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

    const getUsage = Effect.fn("ForkCredentialHttpApi.usage")(function* () {
      return (yield* forkUsageSnapshot({ credentials, usage, auth })).result
    })

    const getGeneralUsage = Effect.fn("ForkCredentialHttpApi.generalUsage")(function* () {
      return yield* capacity.general()
    })

    const getCapacity = Effect.fn("ForkCredentialHttpApi.capacity")(function* () {
      const current = yield* getUsage()
      const accounts = current.byCredential.flatMap((entry) => {
        const window = entry.windows.find((candidate) => candidate.label === "5h")
        if (!window || window.source !== "api" || !(window.limitUSD > 0)) return []
        const status = entry.official?.status
        if (status !== "ok" && status !== "stale") return []
        const snapshotAt = entry.official?.fetchedAt ?? 0
        if (!(snapshotAt > 0)) return []
        // Fresh-vs-stale describes fetch health, not whether the represented
        // rolling window still exists. Any snapshot whose 5h reset has passed
        // is historical evidence and must not be projected into the new window.
        if (window.resetsAt <= Date.now()) return []

        const officialPercent = officialUsedPercent(window)
        if (officialPercent === undefined) return []
        const usedFraction = officialPercent / 100
        // forkUsageSnapshot already merged this credential's official 5h,
        // week, and month windows out of ONE gated snapshot read. Weekly and
        // monthly consumption are independent entitlements, so their observed
        // fractions are handed to Capacity as separate windows instead of
        // being discarded or folded into the 5h resource. "5h" stays the
        // primary resource and is deliberately not repeated here, and no
        // additional provider request is made.
        const observedWindows = entry.windows.flatMap((candidate) => {
          if (candidate.label !== "week" && candidate.label !== "month") return []
          if (candidate.source !== "api") return []
          if (candidate.resetsAt <= Date.now()) return []
          const observedPercent = officialUsedPercent(candidate)
          if (observedPercent === undefined) return []
          const observedFraction = 1 - observedPercent / 100
          return [{
            window: candidate.label,
            remainingFraction: observedFraction,
            resetAt: candidate.resetsAt,
          }]
        })
        return [{
          accountID: entry.accountID ?? entry.credentialID,
          credentialID: entry.credentialID,
          remainingFraction: 1 - usedFraction,
          resetAt: window.resetsAt,
          snapshotAt,
          status,
          ...(observedWindows.length ? { observedWindows } : {}),
        }]
      })

      const go = yield* capacity.go({
        routedAccountID: current.routedAccountID,
        accounts,
      })

      const summaries = (yield* quota.providers()).providers
      const genericSummaries = summaries.filter((provider) => provider.providerId !== "opencode-go")
      const genericResults: ProviderResult[] = yield* Effect.forEach(
        genericSummaries.filter((provider) => provider.configured),
        (provider) =>
          quota.get({ providerID: provider.providerId }).pipe(
            Effect.catch(() =>
              Effect.succeed({
                providerId: provider.providerId,
                providerName: provider.providerName,
                ok: false,
                configured: true,
                error: "Usage data unavailable",
                planLabel: null,
                usage: null,
                fetchedAt: Date.now(),
              }),
            ),
          ),
        { concurrency: 4 },
      )
      const providerProjection = yield* capacity.providers({
        summaries: genericSummaries,
        results: genericResults,
      })

      return {
        ...go,
        providers: [Capacity.goProviderView(go), ...providerProjection.providers],
        generalUsage: providerProjection.generalUsage,
      }
    })

    return handlers
      .handle("list", list)
      .handle("add", add)
      .handle("setDefault", setDefault)
      .handle("rename", rename)
      .handle("remove", remove)
      .handle("usage", getUsage)
      .handle("generalUsage", getGeneralUsage)
      .handle("capacity", getCapacity)
  }),
)


