import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Quota } from "@/quota/quota"
import { RootHttpApi } from "../api"
import { notFound } from "../errors"

export const quotaHandlers = HttpApiBuilder.group(RootHttpApi, "quota", (handlers) =>
  Effect.gen(function* () {
    const quota = yield* Quota.Service

    const providers = Effect.fn("QuotaHttpApi.providers")(function* () {
      return yield* quota.providers()
    })

    const get = Effect.fn("QuotaHttpApi.get")(function* (ctx: { params: { providerID: string } }) {
      return yield* quota.get({ providerID: ctx.params.providerID }).pipe(
        Effect.mapError(() => notFound(`Unsupported quota provider: ${ctx.params.providerID}`)),
      )
    })

    const resets = Effect.fn("QuotaHttpApi.resets")(function* (ctx: { query: { from: number; to: number } }) {
      const { from, to } = ctx.query
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 32 * 24 * 60 * 60 * 1000) {
        return yield* Effect.fail(new HttpApiError.BadRequest())
      }
      return yield* quota.resets({ from, to })
    })

    return handlers.handle("providers", providers).handle("resets", resets).handle("get", get)
  }),
)
