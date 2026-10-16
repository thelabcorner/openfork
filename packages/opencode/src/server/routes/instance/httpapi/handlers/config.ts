import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ConfigReadApi } from "../groups/config"
import { markInstanceForDisposal } from "../lifecycle"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"

export const configReadHandlers = HttpApiBuilder.group(ConfigReadApi, "config-read", (handlers) =>
  Effect.gen(function* () {
    const configSvc = yield* Config.Service

    return handlers.handle("get", () =>
      Effect.gen(function* () {
        const location = yield* WorkspaceRouteContext
        return yield* configSvc.getForLocation({ directory: location.directory })
      }),
    )
  }),
)

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers.handle("update", update).handle("providers", providers)
  }),
)
