import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import type { OxpContext } from "./context"
import { OxpSchema } from "./schema"
import { ExchangeGrounding } from "@/exchange/grounding"
import { ExchangeRead } from "@/exchange/read"

export const statFingerprint = ExchangeRead.statFingerprint

export interface Interface {
  readonly scoped: (connectorID: OxpSchema.ConnectorID) => OxpContext.ReadGrounding
  readonly size: () => number
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpGrounding") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const grounding = yield* ExchangeGrounding.Service
    return Service.of({
      scoped: (connectorID): OxpContext.ReadGrounding => grounding.scoped(connectorID),
      size: grounding.size,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [ExchangeGrounding.node] })

export * as OxpGrounding from "./grounding"
