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
import { forkUsageSnapshot } from "@/fork/usage"

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

        // mergeOfficial writes the exact official percent back into
        // spentUSD/limitUSD. Do NOT use estimatedPercent here: that legacy field
        // may locally refine an integer percentage through the old universal
        // dollar budget, whose denominator is not model-specific.
        const usedFraction = Math.max(0, Math.min(1, window.spentUSD / window.limitUSD))
        return [{
          accountID: entry.accountID ?? entry.credentialID,
          credentialID: entry.credentialID,
          remainingFraction: 1 - usedFraction,
          resetAt: window.resetsAt,
          snapshotAt,
          status,
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
      const providers = yield* capacity.providers({
        summaries: genericSummaries,
        results: genericResults,
      })

      return {
        ...go,
        providers: [Capacity.goProviderView(go), ...providers],
      }
    })

    return handlers
      .handle("list", list)
      .handle("add", add)
      .handle("setDefault", setDefault)
      .handle("rename", rename)
      .handle("remove", remove)
      .handle("usage", getUsage)
      .handle("capacity", getCapacity)
  }),
)


