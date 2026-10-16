import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ModelsQuery } from "@/models/query"
import { Usage } from "@/usage/usage"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"
import { OxpSupervision } from "./supervision"

/** OXP exposes the public model metadata catalog only, never the local account catalog.
 * Session usage is opt-in and verified at admission and at egress. Quota/account
 * metadata deliberately remains native/host-private.
 */
export const Parameters = Schema.Struct({
  ...ModelsQuery.Parameters.fields,
  sessionID: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))).annotate({
    description: "With includeUsage, the exact supervised Session. Does not expose cross-project analytics.",
  }),
  rootID: Schema.optional(OxpSchema.RootID),
})
export type Input = Schema.Schema.Type<typeof Parameters>
export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/OxpModels") {}
export const use = serviceUse(Service)

const layer = Layer.effect(Service, Effect.gen(function* () {
  const catalog = yield* ModelsDev.Service
  const usage = yield* Usage.Service
  const supervision = yield* OxpSupervision.Service
  const authority = yield* OxpAuthority.Service
  const execute: Interface["execute"] = Effect.fn("OxpModels.execute")(function* (input, signal) {
    if (input.scope === "configured") return yield* new OxpError.InvalidArgument({
      detail: "Configured provider catalog belongs to the native host; OXP exposes only public models.dev metadata",
    })
    if (input.includeQuota) return yield* new OxpError.InvalidArgument({
      detail: "Provider-account quota is host-private; OXP does not inherit local account credentials",
    })
    if (input.sessionID && !input.includeUsage) return yield* new OxpError.InvalidArgument({
      detail: "sessionID is only valid with includeUsage=true",
    })
    if (input.includeUsage && !input.sessionID) return yield* new OxpError.InvalidArgument({
      detail: "includeUsage requires an explicitly supervised sessionID",
    })
    if (input.sort === "usage" && !input.includeUsage) return yield* new OxpError.InvalidArgument({
      detail: "sort=usage requires includeUsage and a supervised sessionID",
    })
    if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "Models query cancelled" })
    // This read grant authorizes public catalog metadata only. No Provider.Service,
    // Auth, Quota, workspace Instance, or ambient account state is used here.
    // Rootless global metadata is admitted through the existing info.* class:
    // still requires the OXP read grant, but cannot force workspace bootstrap.
    const read = yield* authority.authorize({ plane: "augmentation", operation: "info.models", phase: "read" })
    const target = input.includeUsage
      ? yield* supervision.resolve(input.sessionID!, "session.get", input.rootID)
      : undefined
    const providers = yield* catalog.get()
    const rows = ModelsQuery.rowsFromProviders(providers)
    let index: Map<string, number> | undefined
    if (target) {
      const history = yield* usage.sessionContext(target.row.id)
      index = new Map()
      for (const model of history?.models ?? []) {
        const key = ModelsQuery.identity(model.providerID, model.modelID)
        index.set(key, (index.get(key) ?? 0) + model.messages)
      }
    }
    const result = yield* Effect.try({
      try: () => ModelsQuery.queryModels(rows, input, index),
      catch: (cause) => new OxpError.InvalidArgument({
        detail: cause instanceof Error ? cause.message : "Invalid models query",
      }),
    })
    if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "Models query cancelled" })
    yield* authority.revalidate(read, "egress")
    if (target) yield* authority.revalidate(target.admission, "egress")
    const structured = {
      ...result,
      source: "public-models-dev",
      availability: "Public catalog entry is NOT evidence of configured local access.",
      quota: "not-inspected-host-private",
      ...(target ? { usage: { source: "authorized-session-settled-usage", sessionID: target.row.id, window: "session-lifetime" } } : {}),
    }
    const list = result.action !== "providers" ? result.models.map((m) =>
      `${m.providerID}/${m.modelID} | ${m.name} | ctx=${m.context ?? "?"}${m.usageMessages === undefined ? "" : ` | session turns=${m.usageMessages}`}`
    ) : result.providers.map((p) => `${p.providerID}: ${p.models} models`)
    return {
      title: "Models catalog",
      output: [`Public models catalog: ${result.returned}/${result.total}`, ...list,
        "Public metadata only. Configured provider access and quota unavailable to this OXP principal.",
      ].join("\n"),
      structured,
      metadata: { source: "public-models-dev", action: input.action ?? "list", count: result.returned },
    } satisfies OxpResult.CapabilityResult
  })
  return Service.of({ execute })
}))
export const node = makeGlobalNode({
  service: Service, layer,
  deps: [ModelsDev.node, Usage.node, OxpSupervision.node, OxpAuthority.node],
})
export * as OxpModels from "./models"
