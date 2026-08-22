import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Quota } from "@/quota/quota"
import { InstanceHttpApi } from "../api"
import { notFound } from "../errors"

export const quotaHandlers = HttpApiBuilder.group(InstanceHttpApi, "quota", (handlers) =>
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

    return handlers.handle("providers", providers).handle("get", get)
  }),
)
